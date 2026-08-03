import { randomBytes } from 'node:crypto';

import { readTx, tx } from '../../db/schema.mjs';
import { aggregateCleanupFailure } from '../../shared/cleanup-error.mjs';

export const HISTORY_GC_BATCH_SIZE = 256;

const HISTORY_CATEGORIES = Object.freeze(['events', 'tasks', 'messages', 'handoffs']);
const PLAN_CHANGED = Symbol('gc-plan-changed');

const CURRENT_TMUX_AUTHORITIES = `
  SELECT MAX(e.id)
  FROM events e
  JOIN peer_bindings b
    ON b.peer = json_extract(e.payload, '$.target_peer')
  WHERE e.type = 'tmux.session.attached'
    AND b.transport = 'tmux'
    AND (b.runtime_target IS NULL OR b.runtime_target = json_extract(e.payload, '$.pane'))
  GROUP BY b.peer, b.runtime_target
`;

function rowById(db, table, column, value) {
  return db.prepare(`SELECT * FROM ${table} WHERE ${column} = ?`).get(value) || null;
}

function deleteExactRow(db, table, row) {
  const columns = Object.keys(row);
  const predicate = columns.map((column) => `${column} IS ?`).join(' AND ');
  return db.prepare(`DELETE FROM ${table} WHERE ${predicate}`)
    .run(...columns.map((column) => row[column])).changes === 1;
}

function captureGcLockSubject(db, resource) {
  const lock = rowById(db, 'locks', 'resource', resource);
  if (!lock) return { lock: null, peer: null, binding: null, authority: null };
  return {
    lock,
    peer: rowById(db, 'peers', 'id', lock.owner),
    binding: rowById(db, 'peer_bindings', 'peer', lock.owner),
    authority: lock.task_id === null || lock.task_id === undefined
      ? null
      : rowById(db, 'tasks', 'id', lock.task_id)
  };
}

export function captureGcLockSubjects(db, observedAt) {
  return db.prepare(`
    SELECT resource FROM locks WHERE expires_at < ? ORDER BY resource ASC
  `).all(observedAt).map(({ resource }) => captureGcLockSubject(db, resource));
}

export function finalizeGcLockSubjects(db, subjects, evidenceByOwner, options = {}) {
  const dryRun = Boolean(options.dryRun);
  return tx(db, () => {
    const result = { deleted: 0, deferred: 0, live: 0 };
    for (const planned of subjects) {
      const owner = planned.lock?.owner;
      const current = planned.lock
        ? captureGcLockSubject(db, planned.lock.resource)
        : { lock: null, peer: null, binding: null, authority: null };
      if (JSON.stringify(current) !== JSON.stringify(planned)) {
        result.deferred += 1;
        continue;
      }
      if (evidenceByOwner.get(owner)?.state === 'live') {
        result.live += 1;
        continue;
      }
      if (dryRun || deleteExactRow(db, 'locks', planned.lock)) result.deleted += 1;
      else result.deferred += 1;
    }
    return result;
  });
}

function normalizeHistoryCategories(categories = HISTORY_CATEGORIES) {
  const requested = new Set(categories);
  for (const category of requested) {
    if (!HISTORY_CATEGORIES.includes(category)) {
      throw new RangeError(`Unknown history GC category: ${category}`);
    }
  }
  return HISTORY_CATEGORIES.filter((category) => requested.has(category));
}

function boundedBatchSize(value) {
  if (value === undefined) return HISTORY_GC_BATCH_SIZE;
  const size = Number(value);
  if (!Number.isSafeInteger(size) || size <= 0) {
    throw new RangeError('History GC batch size must be a positive safe integer');
  }
  return Math.min(size, HISTORY_GC_BATCH_SIZE);
}

function snapshotTableSql(snapshot) {
  if (!snapshot || !/^history_gc_[a-f0-9]{24}$/.test(snapshot.tableName || '')) {
    throw new RangeError('Invalid history GC snapshot');
  }
  return `temp."${snapshot.tableName}"`;
}

function insertSnapshotCategory(db, snapshot, category) {
  const table = snapshotTableSql(snapshot);
  if (category === 'events') {
    db.prepare(`
      INSERT INTO ${table}(category, id)
      SELECT 'events', id FROM events
      WHERE created_at < ? AND id NOT IN (${CURRENT_TMUX_AUTHORITIES})
    `).run(snapshot.cutoff);
  } else if (category === 'tasks') {
    db.prepare(`
      INSERT INTO ${table}(category, id)
      SELECT 'tasks', id FROM tasks
      WHERE status IN ('done', 'abandoned') AND updated_at < ?
    `).run(snapshot.cutoff);
  } else if (category === 'messages') {
    db.prepare(`
      INSERT INTO ${table}(category, id)
      SELECT 'messages', id FROM messages WHERE created_at < ?
    `).run(snapshot.cutoff);
  } else if (category === 'handoffs') {
    db.prepare(`
      INSERT INTO ${table}(category, id)
      SELECT 'handoffs', h.id
      FROM handoffs h
      LEFT JOIN tasks t ON t.id = h.task_id
      WHERE h.created_at < ?
        AND (h.task_id IS NULL OR t.id IS NULL OR t.status IN ('done', 'abandoned'))
    `).run(snapshot.cutoff);
  }
}

function snapshotTimestamp(db, snapshot, category) {
  const table = snapshotTableSql(snapshot);
  let row;
  if (category === 'events') {
    row = db.prepare(`
      SELECT MAX(e.created_at) AS timestamp
      FROM ${table} s JOIN events e ON e.id = s.id
      WHERE s.category = 'events'
    `).get();
  } else if (category === 'tasks') {
    row = db.prepare(`
      SELECT MAX(t.updated_at) AS timestamp
      FROM ${table} s JOIN tasks t ON t.id = s.id
      WHERE s.category = 'tasks'
    `).get();
  } else if (category === 'messages') {
    row = db.prepare(`
      SELECT MAX(m.created_at) AS timestamp
      FROM ${table} s JOIN messages m ON m.id = s.id
      WHERE s.category = 'messages'
    `).get();
  } else if (category === 'handoffs') {
    row = db.prepare(`
      SELECT MAX(h.created_at) AS timestamp
      FROM ${table} s JOIN handoffs h ON h.id = s.id
      WHERE s.category = 'handoffs'
    `).get();
  }
  return row?.timestamp === null || row?.timestamp === undefined
    ? null
    : Number(row.timestamp);
}

export function createHistoryGcSnapshot(db, cutoff, options = {}) {
  const categories = normalizeHistoryCategories(options.categories);
  const batchSize = boundedBatchSize(options.batchSize);
  const retentionSec = Number(options.retentionSec || 0);
  const snapshot = {
    tableName: `history_gc_${randomBytes(12).toString('hex')}`,
    cutoff,
    categories,
    batchSize,
    eligibleCounts: {},
    maxTimestamps: [],
    gcCutoffs: []
  };
  const table = snapshotTableSql(snapshot);
  try {
    readTx(db, () => {
      db.exec(`
        CREATE TEMP TABLE ${table} (
          category TEXT NOT NULL,
          id INTEGER NOT NULL,
          PRIMARY KEY (category, id)
        ) WITHOUT ROWID
      `);
      for (const category of categories) insertSnapshotCategory(db, snapshot, category);
      const counts = new Map(db.prepare(`
        SELECT category, COUNT(*) AS count FROM ${table} GROUP BY category
      `).all().map((row) => [row.category, Number(row.count)]));
      snapshot.eligibleCounts = Object.fromEntries(categories.map((category) => [
        category,
        counts.get(category) || 0
      ]));
      snapshot.maxTimestamps = categories
        .map((category) => snapshotTimestamp(db, snapshot, category))
        .filter((value) => value !== null);
      snapshot.gcCutoffs = snapshot.maxTimestamps.map((value) => value + retentionSec);
    }, {
      cleanupContext: `History GC snapshot read transaction for ${snapshot.tableName}`
    });
    return snapshot;
  } catch (error) {
    cleanupHistoryGcSnapshot(db, snapshot, {
      primaryError: error,
      context: 'History GC snapshot creation'
    });
  }
}

export function dropHistoryGcSnapshot(db, snapshot) {
  db.exec(`DROP TABLE IF EXISTS ${snapshotTableSql(snapshot)}`);
}

function cleanupHistoryGcSnapshot(db, snapshot, options = {}) {
  const hasPrimaryError = Object.hasOwn(options, 'primaryError');
  try {
    dropHistoryGcSnapshot(db, snapshot);
  } catch (cleanupError) {
    if (!hasPrimaryError) throw cleanupError;
    const snapshotName = /^history_gc_[a-f0-9]{24}$/.test(snapshot?.tableName || '')
      ? snapshot.tableName
      : 'unknown snapshot';
    throw aggregateCleanupFailure(
      options.primaryError,
      cleanupError,
      `${options.context || 'History GC operation'} failed and cleanup of ${snapshotName} also failed`,
      {
        context: options.context || 'History GC operation',
        snapshotName
      }
    );
  }
  if (hasPrimaryError) throw options.primaryError;
}

export function runWithHistoryGcSnapshotCleanup(
  db,
  snapshot,
  operation,
  context = 'History GC operation'
) {
  let result;
  try {
    result = operation(snapshot);
  } catch (primaryError) {
    cleanupHistoryGcSnapshot(db, snapshot, { primaryError, context });
  }
  cleanupHistoryGcSnapshot(db, snapshot);
  return result;
}

function normalizedCounts(input, categories, label, maximums = null) {
  return Object.fromEntries(categories.map((category) => {
    const value = Number(input?.[category] || 0);
    if (!Number.isSafeInteger(value) || value < 0 ||
        (maximums && value > maximums[category])) {
      throw new RangeError(`Invalid history GC ${label} for ${category}`);
    }
    return [category, value];
  }));
}

function captureMessages(db, snapshot, afterId, limit) {
  const table = snapshotTableSql(snapshot);
  return db.prepare(`
    SELECT m.*
    FROM ${table} s
    JOIN messages m ON m.id = s.id
    WHERE s.category = 'messages' AND s.id > ? AND m.created_at < ?
    ORDER BY s.id ASC
    LIMIT ?
  `)
    .all(afterId, snapshot.cutoff, limit)
    .map((message) => ({
      message,
      reads: db.prepare(`
        SELECT * FROM message_reads WHERE message_id = ? ORDER BY peer ASC
      `).all(message.id)
    }));
}

function captureHandoffs(db, snapshot, afterId, limit) {
  const table = snapshotTableSql(snapshot);
  return db.prepare(`
    SELECT h.id
    FROM ${table} s
    JOIN handoffs h ON h.id = s.id
    LEFT JOIN tasks t ON t.id = h.task_id
    WHERE s.category = 'handoffs'
      AND s.id > ?
      AND h.created_at < ?
      AND (h.task_id IS NULL OR t.id IS NULL OR t.status IN ('done', 'abandoned'))
    ORDER BY s.id ASC
    LIMIT ?
  `).all(afterId, snapshot.cutoff, limit).map(({ id }) => {
    const handoff = rowById(db, 'handoffs', 'id', id);
    return {
      handoff,
      task: handoff.task_id === null || handoff.task_id === undefined
        ? null
        : rowById(db, 'tasks', 'id', handoff.task_id)
    };
  });
}

export function captureHistoryGcPlan(db, cutoff, options = {}) {
  const ownsSnapshot = !options.snapshot;
  const snapshot = options.snapshot || createHistoryGcSnapshot(db, cutoff, options);
  try {
    return captureHistoryGcPlanFromSnapshot(db, cutoff, options, snapshot);
  } catch (error) {
    if (!ownsSnapshot) throw error;
    cleanupHistoryGcSnapshot(db, snapshot, {
      primaryError: error,
      context: 'History GC plan construction'
    });
  }
}

function captureHistoryGcPlanFromSnapshot(db, cutoff, options, snapshot) {
  const categories = snapshot.categories;
  const batchSize = snapshot.batchSize;
  if (Number(cutoff) !== Number(snapshot.cutoff)) {
    throw new RangeError('History GC snapshot cutoff does not match the plan cutoff');
  }
  if (options.categories &&
      JSON.stringify(normalizeHistoryCategories(options.categories)) !== JSON.stringify(categories)) {
    throw new RangeError('History GC snapshot categories do not match the plan categories');
  }
  const after = Object.fromEntries(categories.map((category) => [
    category,
    Number(options.after?.[category] || 0)
  ]));
  const eligibleCounts = snapshot.eligibleCounts;
  const processedCounts = normalizedCounts(
    options.processedCounts,
    categories,
    'processed count',
    eligibleCounts
  );
  const remainingCounts = Object.fromEntries(categories.map((category) => [
    category,
    eligibleCounts[category] - processedCounts[category]
  ]));
  const plan = {
    cutoff,
    categories,
    batchSize,
    snapshot,
    after,
    eligibleCounts,
    processedCounts,
    remainingCounts,
    nextAfter: { ...after },
    events: [],
    tasks: [],
    messages: [],
    handoffs: []
  };
  const activeCategories = categories.filter((category) => remainingCounts[category] > 0);
  const baseAllocation = activeCategories.length > 0
    ? Math.floor(batchSize / activeCategories.length)
    : 0;
  const extraAllocations = activeCategories.length > 0
    ? batchSize % activeCategories.length
    : 0;

  for (const [index, category] of activeCategories.entries()) {
    const allocation = Math.min(
      remainingCounts[category],
      baseAllocation + (index < extraAllocations ? 1 : 0)
    );
    if (allocation === 0) continue;
    if (category === 'events') {
      const table = snapshotTableSql(snapshot);
      plan.events = db.prepare(`
        SELECT e.*
        FROM ${table} s
        JOIN events e ON e.id = s.id
        WHERE s.category = 'events' AND s.id > ? AND e.created_at < ?
          AND e.id NOT IN (${CURRENT_TMUX_AUTHORITIES})
        ORDER BY s.id ASC
        LIMIT ?
      `).all(after.events, cutoff, allocation);
    } else if (category === 'tasks') {
      const table = snapshotTableSql(snapshot);
      plan.tasks = db.prepare(`
        SELECT t.*
        FROM ${table} s
        JOIN tasks t ON t.id = s.id
        WHERE s.category = 'tasks' AND s.id > ?
          AND t.status IN ('done', 'abandoned') AND t.updated_at < ?
        ORDER BY s.id ASC
        LIMIT ?
      `).all(after.tasks, cutoff, allocation);
    } else if (category === 'messages') {
      plan.messages = captureMessages(db, snapshot, after.messages, allocation);
    } else if (category === 'handoffs') {
      plan.handoffs = captureHandoffs(db, snapshot, after.handoffs, allocation);
    }
    const rows = category === 'messages'
      ? plan.messages.map(({ message }) => message)
      : category === 'handoffs'
        ? plan.handoffs.map(({ handoff }) => handoff)
        : plan[category];
    if (rows.length > 0) plan.nextAfter[category] = Number(rows.at(-1).id);
  }
  return plan;
}

export function captureHistoryGcCutoffs(db, cutoff, retentionSec, options = {}) {
  if (options.snapshot) {
    return options.snapshot.maxTimestamps.map((value) => value + retentionSec);
  }
  const snapshot = createHistoryGcSnapshot(db, cutoff, { ...options, retentionSec });
  return runWithHistoryGcSnapshotCleanup(
    db,
    snapshot,
    () => [...snapshot.gcCutoffs],
    'History GC cutoff capture'
  );
}

function selectedPlan(plan, categories) {
  return Object.fromEntries(categories.map((category) => [category, plan[category]]));
}

function planCounts(plan, categories) {
  return {
    old_events: categories.includes('events') ? (plan.events?.length || 0) : 0,
    old_tasks: categories.includes('tasks') ? (plan.tasks?.length || 0) : 0,
    old_messages: categories.includes('messages') ? (plan.messages?.length || 0) : 0,
    old_handoffs: categories.includes('handoffs') ? (plan.handoffs?.length || 0) : 0
  };
}

export function finalizeHistoryGcPlan(db, plan, options = {}) {
  const categories = normalizeHistoryCategories(options.categories || plan.categories);
  const counts = planCounts(plan, categories);
  const plannedTotal = Object.values(counts).reduce((sum, count) => sum + count, 0);
  const deferredRemainder = plan.remainingCounts
    ? categories.reduce((sum, category) => sum + Number(plan.remainingCounts[category]), 0)
    : plannedTotal;
  try {
    return tx(db, () => {
      const current = captureHistoryGcPlan(db, plan.cutoff, {
        snapshot: plan.snapshot,
        categories,
        after: plan.after,
        processedCounts: plan.processedCounts,
        batchSize: plan.batchSize
      });
      if (JSON.stringify(selectedPlan(current, categories)) !==
          JSON.stringify(selectedPlan(plan, categories))) {
        return { applied: false, ...planCounts({ events: [], tasks: [], messages: [], handoffs: [] }, categories), deferred: deferredRemainder };
      }
      if (!options.dryRun) {
        for (const event of categories.includes('events') ? plan.events : []) {
          if (!deleteExactRow(db, 'events', event)) throw PLAN_CHANGED;
        }
        for (const task of categories.includes('tasks') ? plan.tasks : []) {
          if (!deleteExactRow(db, 'tasks', task)) throw PLAN_CHANGED;
        }
        for (const { message } of categories.includes('messages') ? plan.messages : []) {
          if (!deleteExactRow(db, 'messages', message)) throw PLAN_CHANGED;
        }
        for (const { handoff } of categories.includes('handoffs') ? plan.handoffs : []) {
          if (!deleteExactRow(db, 'handoffs', handoff)) throw PLAN_CHANGED;
        }
      }
      return { applied: true, ...counts, deferred: 0 };
    });
  } catch (error) {
    if (error !== PLAN_CHANGED) throw error;
    return {
      applied: false,
      old_events: 0,
      old_tasks: 0,
      old_messages: 0,
      old_handoffs: 0,
      deferred: deferredRemainder
    };
  }
}

function historyPlanCount(plan) {
  return plan.events.length + plan.tasks.length + plan.messages.length + plan.handoffs.length;
}

function processedCountsFromResult(result) {
  return {
    events: result.old_events,
    tasks: result.old_tasks,
    messages: result.old_messages,
    handoffs: result.old_handoffs
  };
}

export function finalizeHistoryGcBatches(db, initialPlan, options = {}) {
  const alreadyProcessed = initialPlan.processedCounts || {};
  const totals = {
    old_events: Number(alreadyProcessed.events || 0),
    old_tasks: Number(alreadyProcessed.tasks || 0),
    old_messages: Number(alreadyProcessed.messages || 0),
    old_handoffs: Number(alreadyProcessed.handoffs || 0),
    deferred: 0
  };
  const eligibleCounts = initialPlan.eligibleCounts;
  const processBatches = () => {
    let plan = initialPlan;
    while (historyPlanCount(plan) > 0) {
      const result = finalizeHistoryGcPlan(db, plan, { dryRun: options.dryRun });
      totals.old_events += result.old_events;
      totals.old_tasks += result.old_tasks;
      totals.old_messages += result.old_messages;
      totals.old_handoffs += result.old_handoffs;
      totals.deferred += result.deferred;
      if (!result.applied) break;

      plan = captureHistoryGcPlan(db, plan.cutoff, {
        snapshot: plan.snapshot,
        categories: plan.categories,
        after: plan.nextAfter,
        processedCounts: processedCountsFromResult(totals),
        batchSize: plan.batchSize
      });
    }
    const processedCounts = processedCountsFromResult(totals);
    const snapshotRemainder = initialPlan.categories.reduce(
      (sum, category) => sum + eligibleCounts[category] - processedCounts[category],
      0
    );
    totals.deferred = Math.max(totals.deferred, snapshotRemainder);
    return totals;
  };
  if (options.dropSnapshot === false) return processBatches();
  return runWithHistoryGcSnapshotCleanup(
    db,
    initialPlan.snapshot,
    processBatches,
    'History GC batch processing'
  );
}

export function historyGcCutoffs(plan, retentionSec) {
  const cutoffs = [];
  const categories = normalizeHistoryCategories(plan.categories);
  for (const category of categories) {
    const entries = plan[category] || [];
    const timestamp = category === 'tasks' ? 'updated_at' : 'created_at';
    let maximum = null;
    for (const entry of entries) {
      const row = category === 'messages'
        ? entry.message
        : category === 'handoffs'
          ? entry.handoff
          : entry;
      const value = Number(row[timestamp]);
      if (maximum === null || value > maximum) maximum = value;
    }
    if (maximum !== null) cutoffs.push(maximum + retentionSec);
  }
  return cutoffs;
}
