'use strict';
// Test-only controlled presentation change: the same captured document fields
// are shown literally, and the insertion point is repeated last for prose too.
exports.literalGap = body => {
  const message = body.messages.at(-1);
  if(!message.content.startsWith('{'))return body;
  const data = JSON.parse(message.content);
  const insertion = data.formula || data.before.slice(-480) + '⟦INSERT⟧' + data.after.split('\n')[0].slice(0, 240);
  const source = [
    'The following sections contain literal document data. Backslashes are LaTeX characters, not JSON escapes.',
    '<editing_context>' + data.kind + '; ' + data.intent + '</editing_context>',
    '<heading>\n' + data.heading + '\n</heading>',
    '<nearby>\n' + data.nearby + '\n</nearby>',
    '<existing_suffix>\n' + data.after + '\n</existing_suffix>',
    '<existing_prefix>\n' + data.before + '\n</existing_prefix>',
    '<insertion_site>\n' + insertion + '\n</insertion_site>',
    'Return only the text that replaces ⟦INSERT⟧ in insertion_site. Do not continue existing_suffix.',
  ].join('\n\n');
  return {...body, system: body.system.replace('JSON fields', 'document sections'), messages: [...body.messages.slice(0, -1), {...message, content: source}]};
};
// Inspect fixed test fixtures without coupling assertions to JSON encoding.
exports.inspectSource = content => {
  const section=name=>content.split('<'+name+'>\n')[1]?.split('\n</'+name+'>')[0];
  const editing=content.match(/<editing_context>([^;]+); ([^<]+)<\/editing_context>/);
  return {kind:editing?.[1],intent:editing?.[2],before:section('existing_prefix'),after:section('existing_suffix'),heading:section('heading'),formula:section('insertion_site')};
};
