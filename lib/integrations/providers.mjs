import { CliError } from '../shared/errors.mjs';
import { shellQuoteArg } from '../format.mjs';
import { providerSessionParts } from '../core/peers/session.mjs';

export {
  providerSessionParts,
  providerSessionPeerId
} from '../core/peers/session.mjs';

function shellCommand(args) {
  return args.map(shellQuoteArg).join(' ');
}

export function inferPeerKind(id, explicitKind, firstCommand) {
  if (explicitKind) return explicitKind;
  if (['codex', 'claude'].includes(firstCommand)) return firstCommand;
  if (String(id).startsWith('codex')) return 'codex';
  if (String(id).startsWith('claude')) return 'claude';
  return 'shell';
}

export function hasResumeOpts(opts) {
  return opts.resume !== undefined || Boolean(opts.last) || Boolean(opts.continue) || Boolean(opts.fork) || opts.session !== undefined;
}

export function defaultSessionCommand(kind) {
  if (kind === 'codex') return 'codex';
  if (kind === 'claude') return 'claude';
  return process.env.SHELL || 'bash';
}

export function buildPeerCommand(id, kind, opts, cmdArgs) {
  const explicitCommand = opts.command || cmdArgs.length > 0;
  if (explicitCommand && hasResumeOpts(opts)) {
    throw new CliError('BAD_ARGS', 'Use resume options without an explicit -- COMMAND');
  }
  if (explicitCommand) {
    const command = opts.command || shellCommand(cmdArgs);
    return {
      command,
      binding: {
        peer: id,
        provider: kind,
        resume_mode: 'command',
        resume_arg: null,
        command
      }
    };
  }
  if (kind === 'codex') return buildCodexCommand(id, opts);
  if (kind === 'claude') return buildClaudeCommand(id, opts);
  if (hasResumeOpts(opts)) throw new CliError('BAD_ARGS', `Resume options are only supported for codex and claude peers`);
  const command = defaultSessionCommand(kind);
  return {
    command,
    binding: {
      peer: id,
      provider: kind,
      resume_mode: 'new',
      resume_arg: null,
      command
    }
  };
}

export function buildCodexCommand(id, opts) {
  let command;
  let resumeMode = 'new';
  let resumeArg = null;
  let session = { provider_session_id: null, provider_session_name: null };
  if (opts.fork) {
    resumeMode = opts.last ? 'fork-last' : 'fork';
    if (opts.last) {
      command = 'codex fork --last';
      resumeArg = '--last';
    } else if (opts.resume) {
      command = `codex fork ${shellQuoteArg(opts.resume)}`;
      resumeArg = opts.resume;
    } else {
      command = 'codex fork';
    }
  } else if (opts.last) {
    command = 'codex resume --last';
    resumeMode = 'last';
    resumeArg = '--last';
  } else if (opts.resume) {
    command = `codex resume ${shellQuoteArg(opts.resume)}`;
    resumeMode = 'resume';
    resumeArg = opts.resume;
    session = providerSessionParts(opts.resume);
  } else {
    command = 'codex';
  }
  return {
    command,
    binding: {
      peer: id,
      provider: 'codex',
      ...session,
      resume_mode: resumeMode,
      resume_arg: resumeArg,
      command
    }
  };
}

export function buildClaudeCommand(id, opts) {
  let command = 'claude';
  let resumeMode = 'new';
  let resumeArg = null;
  let session = { provider_session_id: null, provider_session_name: null };
  if (opts.continue) {
    command += ' --continue';
    resumeMode = opts.fork ? 'fork-continue' : 'continue';
    resumeArg = '--continue';
  } else if (opts.resume) {
    command += ` --resume ${shellQuoteArg(opts.resume)}`;
    resumeMode = opts.fork ? 'fork-resume' : 'resume';
    resumeArg = opts.resume;
    if (!opts.fork) session = providerSessionParts(opts.resume);
  } else if (opts.session) {
    command += ` --session-id ${shellQuoteArg(opts.session)}`;
    resumeMode = 'session';
    resumeArg = opts.session;
    session = { provider_session_id: opts.session, provider_session_name: null };
  }
  if (opts.fork && (opts.continue || opts.resume)) command += ' --fork-session';
  if (opts.name) command += ` --name ${shellQuoteArg(opts.name)}`;
  return {
    command,
    binding: {
      peer: id,
      provider: 'claude',
      ...session,
      resume_mode: resumeMode,
      resume_arg: resumeArg,
      command
    }
  };
}

export function bindingFromRun(id, kind, command, commandArgs, transport) {
  const cmdline = [command, ...commandArgs];
  const provider = kind || 'other';
  let resumeMode = 'command';
  let resumeArg = null;
  let session = { provider_session_id: null, provider_session_name: null };
  if (provider === 'codex') {
    const parsed = parseCodexCommandArgs(cmdline);
    resumeMode = parsed.resume_mode;
    resumeArg = parsed.resume_arg;
    session = parsed.session;
  } else if (provider === 'claude') {
    const parsed = parseClaudeCommandArgs(cmdline);
    resumeMode = parsed.resume_mode;
    resumeArg = parsed.resume_arg;
    session = parsed.session;
  }
  return {
    peer: id,
    provider,
    ...session,
    resume_mode: resumeMode,
    resume_arg: resumeArg,
    command: cmdline.join(' '),
    transport,
    runtime_session_id: id
  };
}

function optionValue(args, names) {
  const nameSet = new Set(names);
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (nameSet.has(arg) && args[i + 1]) return args[i + 1];
    for (const name of names) {
      if (name.startsWith('--') && arg.startsWith(`${name}=`)) return arg.slice(name.length + 1);
    }
  }
  return null;
}

function hasFlag(args, names) {
  const nameSet = new Set(names);
  return args.some((arg) => nameSet.has(arg));
}

export function parseClaudeCommandArgs(args) {
  const resumeId = optionValue(args, ['--resume', '-r']);
  const sessionId = optionValue(args, ['--session-id']);
  const name = optionValue(args, ['--name', '-n']);
  const continuing = hasFlag(args, ['--continue', '-c']);
  const fork = hasFlag(args, ['--fork-session']);
  let resumeMode = 'command';
  let resumeArg = null;
  let session = { provider_session_id: null, provider_session_name: null };

  if (sessionId) {
    resumeMode = 'session';
    resumeArg = sessionId;
    session = { provider_session_id: sessionId, provider_session_name: null };
  } else if (resumeId) {
    resumeMode = fork ? 'fork-resume' : 'resume';
    resumeArg = resumeId;
    if (!fork) session = providerSessionParts(resumeId);
  } else if (continuing) {
    resumeMode = fork ? 'fork-continue' : 'continue';
    resumeArg = '--continue';
  } else if (fork) {
    resumeMode = 'fork';
  } else if (name) {
    resumeMode = 'named';
    resumeArg = name;
  }

  return { resume_mode: resumeMode, resume_arg: resumeArg, session };
}

function codexOptionTakesValue(arg) {
  if (!arg || arg.includes('=')) return false;
  return new Set([
    '-c', '--config',
    '--remote',
    '--remote-auth-token-env',
    '--enable',
    '--disable',
    '-i', '--image',
    '-m', '--model',
    '--local-provider',
    '-p', '--profile',
    '-s', '--sandbox',
    '-C', '--cd',
    '--add-dir',
    '-a', '--ask-for-approval'
  ]).has(arg);
}

function firstCodexSessionArg(args, startIndex) {
  for (let i = startIndex; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--last') continue;
    if (arg.startsWith('-')) {
      if (codexOptionTakesValue(arg)) i += 1;
      continue;
    }
    return arg;
  }
  return null;
}

export function parseCodexCommandArgs(args) {
  const subIndex = args.findIndex((arg) => arg === 'resume' || arg === 'fork');
  if (subIndex < 0) {
    return {
      resume_mode: 'command',
      resume_arg: null,
      session: { provider_session_id: null, provider_session_name: null }
    };
  }

  const subcommand = args[subIndex];
  const last = args.slice(subIndex + 1).includes('--last');
  const sessionArg = firstCodexSessionArg(args, subIndex + 1);
  let resumeMode = subcommand;
  let resumeArg = sessionArg || null;
  let session = { provider_session_id: null, provider_session_name: null };

  if (subcommand === 'resume') {
    if (last && !sessionArg) {
      resumeMode = 'last';
      resumeArg = '--last';
    } else if (sessionArg) {
      resumeMode = 'resume';
      session = providerSessionParts(sessionArg);
    }
  } else if (subcommand === 'fork') {
    resumeMode = last && !sessionArg ? 'fork-last' : 'fork';
    resumeArg = sessionArg || (last ? '--last' : null);
  }

  return { resume_mode: resumeMode, resume_arg: resumeArg, session };
}
