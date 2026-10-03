// Bounded MCP 2025-11-25 form schemas. This factory is also embedded in the Web
// responder so the UI and owning executor apply the same constraints.
export function createMcpFormValidator() {
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const own = (value, key) => Object.hasOwn(value, key);
  function fail(message) { throw Object.assign(new Error(message), { code: 'INTERACTION_RESPONSE_INVALID' }); }
  function shape(value, allowed) {
    if (!object(value) || Object.keys(value).some(key => !allowed.includes(key))) fail('Unsupported MCP form schema');
  }
  function text(value) { return typeof value === 'string' && value.length <= 8192; }
  function bound(value) { return Number.isSafeInteger(value) && value >= 0; }
  function options(schema, titledKey, legacy = false) {
    let values;
    if (own(schema, 'enum')) {
      if (!Array.isArray(schema.enum) || schema.enum.some(value => !text(value))) fail('Invalid MCP form options');
      if (legacy && own(schema, 'enumNames') && (!Array.isArray(schema.enumNames) || schema.enumNames.length !== schema.enum.length || schema.enumNames.some(value => !text(value)))) fail('Invalid MCP option labels');
      values = schema.enum.map((value, i) => ({ value, label: schema.enumNames?.[i] ?? value }));
    } else {
      if (!Array.isArray(schema[titledKey])) fail('Invalid MCP form options');
      values = schema[titledKey].map(entry => {
        shape(entry, ['const', 'title']);
        if (!text(entry.const) || !text(entry.title)) fail('Invalid MCP form options');
        return { value: entry.const, label: entry.title };
      });
    }
    if (!values.length || values.length > 100 || new Set(values.map(entry => entry.value)).size !== values.length) fail('Invalid or excessive MCP form options');
    return values;
  }
  function date(value) {
    return (/^\d{4}-\d{2}-\d{2}$/).test(value) && Number.isFinite(Date.parse(value + 'T00:00:00Z')) && new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) === value;
  }
  function formatted(value, format) {
    if (format === 'email') {
      const at = value.lastIndexOf('@'), local = value.slice(0, at), domain = value.slice(at + 1);
      // Common dot-atom/quoted mailbox syntax and DNS labels; no network lookup.
      const mailbox = (/^(?:[A-Za-z0-9!#$%&'*+\/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+\/=?^_`{|}~-]+)*|"(?:[^"\\\r\n]|\\[^\r\n])*")$/).test(local);
      const host = (/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*$/).test(domain);
      return at > 0 && mailbox && host && domain.split('.').every(label => label.length <= 63);
    }
    if (format === 'uri') {
      if (/[^\x21-\x7e]|["<>`{}|\\^]|%(?![\da-fA-F]{2})/.test(value)) return false;
      try { return Boolean(new URL(value).protocol); } catch { return false; }
    }
    if (format === 'date') return date(value);
    if (format === 'date-time') {
      const match = /^(\d{4}-\d{2}-\d{2})[tT](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:[zZ]|[+-](\d{2}):(\d{2}))$/.exec(value);
      return Boolean(match && date(match[1]) && Number(match[2]) < 24 && Number(match[3]) < 60 && Number(match[4]) <= 60 && (!match[5] || (Number(match[5]) < 24 && Number(match[6]) < 60)));
    }
    return true;
  }
  function validateValue(field, value) {
    const error = () => fail('Invalid value for MCP field: ' + field.key);
    if (field.kind === 'multi') {
      if (!Array.isArray(value) || value.length > 100 || value.length < (field.minItems ?? 0) || value.length > (field.maxItems ?? 100) || new Set(value).size !== value.length || value.some(entry => !field.options.some(option => option.value === entry))) error();
    } else if (field.kind === 'enum') {
      if (!field.options.some(option => option.value === value)) error();
    } else if (field.type === 'boolean') {
      if (typeof value !== 'boolean') error();
    } else if (field.type === 'number' || field.type === 'integer') {
      if (typeof value !== 'number' || !Number.isFinite(value) || (field.type === 'integer' && !Number.isSafeInteger(value)) || (field.minimum != null && value < field.minimum) || (field.maximum != null && value > field.maximum)) error();
    } else {
      if (!text(value) || Array.from(value).length < (field.minLength ?? 0) || Array.from(value).length > (field.maxLength ?? 8192) || !formatted(value, field.format)) error();
    }
  }
  function describe(params) {
    if (params?.mode !== 'form') fail('This MCP request mode cannot be answered in Web; decline or cancel');
    const schema = params.requestedSchema;
    shape(schema, ['$schema', 'type', 'properties', 'required', 'additionalProperties']);
    if (schema.type !== 'object' || !object(schema.properties) || (own(schema, '$schema') && !text(schema.$schema)) || (own(schema, 'additionalProperties') && typeof schema.additionalProperties !== 'boolean') || JSON.stringify(schema).length > 65536) fail('Unsupported MCP form schema');
    const entries = Object.entries(schema.properties), required = own(schema, 'required') ? schema.required : [];
    if (entries.length > 50 || !Array.isArray(required) || new Set(required).size !== required.length || required.some(key => typeof key !== 'string' || !own(schema.properties, key))) fail('Invalid or excessive MCP form fields');
    const fields = entries.map(([key, definition]) => {
      if (!key || key.length > 512 || !object(definition)) fail('Invalid MCP field identity');
      const type = definition.type;
      let allowed, kind = type;
      if (type === 'string') {
        kind = own(definition, 'enum') || own(definition, 'oneOf') ? 'enum' : 'string';
        allowed = kind === 'enum' ? (own(definition, 'enum') ? ['enum', 'enumNames'] : ['oneOf']) : ['minLength', 'maxLength', 'format'];
      } else if (type === 'array') { kind = 'multi'; allowed = ['items', 'minItems', 'maxItems']; }
      else if (type === 'boolean') allowed = [];
      else if (type === 'number' || type === 'integer') allowed = ['minimum', 'maximum'];
      else fail('Nested objects or unsupported MCP field types cannot be answered in Web');
      shape(definition, ['type', 'title', 'description', 'default', ...allowed]);
      for (const property of ['title', 'description']) if (own(definition, property) && !text(definition[property])) fail('Invalid MCP field label');
      const field = { ...definition, key, kind, required: required.includes(key) };
      for (const property of ['minLength', 'maxLength', 'minItems', 'maxItems']) if (own(definition, property) && !bound(definition[property])) fail('Invalid MCP field bounds');
      for (const property of ['minimum', 'maximum']) if (own(definition, property) && (typeof definition[property] !== 'number' || !Number.isFinite(definition[property]))) fail('Invalid MCP numeric bounds');
      if ((definition.minLength ?? 0) > Math.min(definition.maxLength ?? 8192, 8192) || (definition.minimum != null && definition.maximum != null && definition.minimum > definition.maximum) || (own(definition, 'format') && !['email', 'uri', 'date', 'date-time'].includes(definition.format))) fail('Unsupported or unsatisfiable MCP field constraints');
      if (kind === 'enum') field.options = options(definition, 'oneOf', true);
      if (kind === 'multi') {
        const items = definition.items;
        if (own(items || {}, 'enum')) { shape(items, ['type', 'enum']); if (items.type !== 'string') fail('Unsupported MCP array items'); }
        else shape(items, [own(items || {}, 'anyOf') ? 'anyOf' : 'oneOf']);
        field.options = options(items, own(items, 'anyOf') ? 'anyOf' : 'oneOf');
        if ((definition.minItems ?? 0) > Math.min(definition.maxItems ?? 100, field.options.length)) fail('Unsatisfiable MCP selection constraints');
      }
      if (own(definition, 'default')) validateValue(field, definition.default);
      return field;
    });
    return { fields };
  }
  function validate(params, content) {
    const { fields } = describe(params);
    if (!object(content) || Object.keys(content).some(key => !fields.some(field => field.key === key))) fail('MCP form content must contain only requested fields');
    const result = {};
    for (const field of fields) {
      if (!own(content, field.key)) { if (field.required) fail('Required MCP field is missing: ' + field.key); continue; }
      validateValue(field, content[field.key]);
      // Field names are untrusted. Define own properties without invoking setters.
      Object.defineProperty(result, field.key, { value: Array.isArray(content[field.key]) ? [...content[field.key]] : content[field.key], enumerable: true, configurable: true, writable: true });
    }
    if (JSON.stringify(result).length > 65536) fail('MCP form content exceeds the response limit');
    return result;
  }
  return { describe, validate };
}
