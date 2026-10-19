#!/usr/bin/env node
/**
 * Validate this preset bundle the way the running DSH host will read it.
 *
 * Two independent checks, both borrowed from the host itself:
 *   1. YAML — parse with the Loader's OWN dialect. The dialect is
 *      `yaml.JSON_SCHEMA` extended with the `!!js` scalar type, which is exactly
 *      what `@deepseek-ai/cordis-plugin-include` builds for the Loader (see its
 *      `JsExpr`), so `!!js` conditions parse the way the host parses them
 *      instead of failing as an unknown tag.
 *   2. Shape — every row is a map naming a plugin; the preset declaration
 *      carries `config.id` / `config.plugins`, and the id matches the id rules
 *      the roster would accept.
 *
 * Usage:
 *   node validate-preset.mjs [path-to-cordis.patch.yml]
 * Exit code 0 = loadable shape, 1 = would be rejected.
 */
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const patchPath = resolve(process.argv[2] ?? join(here, 'cordis.patch.yml'))

/** The host's js-yaml build, extracted from the running app.asar by tools/extract-asar.mjs. */
const YAML_CANDIDATES = [
  join(here, '.preset-validate', 'node_modules', 'js-yaml', 'index.js'),
  join(here, 'node_modules', 'js-yaml', 'index.js'),
]

const failures = []
const notes = []

const yamlPath = YAML_CANDIDATES.find(candidate => existsSync(candidate))
if (yamlPath === undefined) {
  console.error('cannot find js-yaml; extract the host\'s own copy with:')
  console.error('  node tools/extract-asar.mjs "<app.asar>" "dsh/node_modules/js-yaml" ".preset-validate/node_modules/js-yaml"')
  console.error(`looked in:\n  ${YAML_CANDIDATES.join('\n  ')}`)
  process.exit(2)
}

const yaml = await import(pathToFileURL(yamlPath).href)
const loadYaml = yaml.load ?? yaml.default?.load
if (typeof loadYaml !== 'function') {
  console.error(`the module at ${yamlPath} exports no load()`)
  process.exit(2)
}

// ── the Loader's `!!js` scalar: a tagged string the Loader evaluates later ────
const JsExpr = new yaml.Type('tag:yaml.org,2002:js', {
  kind: 'scalar',
  resolve: data => typeof data === 'string',
  construct: data => ({ __jsExpr: data }),
})
const entryListSchema = yaml.JSON_SCHEMA.extend(JsExpr)

/** A plugin `name` is either a literal string or a deferred `!!js` expression. */
const isName = value => typeof value === 'string' ? value.length > 0 : value !== null && typeof value === 'object' && typeof value.__jsExpr === 'string'
const nameOf = value => typeof value === 'string' ? value : `!!js ${String(value?.__jsExpr)}`

const PRESET_ID = /^[a-z0-9][a-z0-9-]*$/

// ── 1. parse ─────────────────────────────────────────────────────────────────

if (!existsSync(patchPath)) {
  console.error(`FAIL  patch file does not exist: ${patchPath}`)
  process.exit(1)
}

let doc
try {
  doc = loadYaml(readFileSync(patchPath, 'utf8'), { schema: entryListSchema })
} catch (error) {
  console.error(`FAIL  not valid loader-dialect YAML: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`)
  process.exit(1)
}
notes.push(`parsed with the host dialect: ${doc.length} top-level patch row(s)`)

// ── 2. shape ─────────────────────────────────────────────────────────────────

const declared = []
const pluginRows = []

function checkPluginRows(rows, at) {
  if (!Array.isArray(rows)) {
    failures.push(`${at}: expected a list of plugin rows`)
    return
  }
  rows.forEach((row, index) => {
    const label = `${at}[${index}]`
    if (typeof row !== 'object' || row === null || Array.isArray(row)) {
      failures.push(`${label}: not a plugin row (expected a map with a "name")`)
      return
    }
    if (!isName(row.name)) {
      failures.push(`${label}: names no plugin (a "name" string is required)`)
      return
    }
    const name = nameOf(row.name)
    if (row.group === true) {
      if (!Array.isArray(row.config)) failures.push(`${label} (${name}): a group row needs a nested list in "config"`)
      else checkPluginRows(row.config, `${label}.config`)
      return
    }
    pluginRows.push({ name, id: typeof row.id === 'string' ? row.id : undefined, disabled: row.disabled !== undefined })
    if (name === '@deepseek-ai/dsh-agent-preset') {
      const config = row.config ?? {}
      if (typeof config.id !== 'string' || !PRESET_ID.test(config.id)) {
        failures.push(`${label}: preset id must match ${String(PRESET_ID)} — got ${JSON.stringify(config.id)}`)
      }
      if (!Array.isArray(config.plugins) || config.plugins.length === 0) {
        failures.push(`${label}: "config.plugins" must be a non-empty list`)
      } else {
        declared.push({ id: config.id, order: config.order, declarationRow: row.id, plugins: config.plugins })
        checkPluginRows(config.plugins, `${label}.config.plugins`)
      }
    }
  })
}

if (!Array.isArray(doc)) {
  failures.push(`the bundle patch must be a top-level list of patch rows; got ${typeof doc}`)
} else {
  doc.forEach((row, index) => {
    const label = `row[${index}]`
    if (typeof row !== 'object' || row === null || Array.isArray(row)) {
      failures.push(`${label}: not a patch row`)
      return
    }
    if (row.insert !== undefined) {
      if (!Array.isArray(row.insert)) failures.push(`${label}.insert: must be a list of plugin rows`)
      else checkPluginRows(row.insert, `${label}.insert`)
      return
    }
    if (typeof row.id !== 'string' || row.id === '') failures.push(`${label}: a patch row must carry a string "id"`)
  })
}

// ── 3. this project's own contract ───────────────────────────────────────────

if (declared.length !== 1) failures.push(`expected exactly one @deepseek-ai/dsh-agent-preset declaration, found ${declared.length}`)

/**
 * Config keys each row's plugin actually declares, read from the RUNNING host.
 *
 * This is the check that was missing when the persona row shipped with `text:`
 * — a field this deployment's `dsh-persona` does not have. Its `Config` is
 * `{ prefix: required, suffix, complete, includeRuntimeContext }`, so the row
 * rejected at mount, the audit reported it, and the WHOLE preset became
 * `broken` (which is what hides it from the new-session picker).
 *
 * Names come from the running app.asar, never from a source checkout: the
 * master checkout's persona uses `text`, and that disagreement is precisely
 * what broke this preset. Each row records the host package to read.
 */
const ROW_CONFIG_KEYS = new Map([
  ['@deepseek-ai/dsh-persona', { required: ['prefix'], optional: ['suffix', 'complete', 'includeRuntimeContext'] }],
])

/** Flatten every declared child row of the preset (groups recurse). */
const declaredRows = declared.flatMap(entry => entry.plugins ?? []).flatMap(function flatten(row) {
  if (row === null || typeof row !== 'object') return []
  const here = [row]
  return Array.isArray(row.config) && row.group === true ? [...here, ...row.config.flatMap(flatten)] : here
})

for (const row of declaredRows) {
  const spec = typeof row.name === 'string' ? ROW_CONFIG_KEYS.get(row.name) : undefined
  if (spec === undefined) continue
  const config = row.config
  if (config === undefined) {
    if (spec.required.length > 0) failures.push(`${row.name}: config is required but absent — needs ${spec.required.join(', ')}`)
    continue
  }
  const allowed = new Set([...spec.required, ...spec.optional])
  for (const key of Object.keys(config)) {
    if (!allowed.has(key)) {
      failures.push(
        `${row.name}: config field "${key}" is not in this deployment's schema (allowed: ${[...allowed].join(', ')}) — `
        + 'an unknown/missing field rejects the row at mount, which marks the WHOLE preset broken',
      )
    }
  }
  for (const key of spec.required) {
    if (!(key in config)) failures.push(`${row.name}: config.${key} is REQUIRED by this deployment's schema and is missing`)
  }
}

/** Host-plane packages whose apply() must run exactly once in the process. */
const FORBIDDEN = [
  '@dsh-external/dsh-harness-pilot',
  '@dsh-external/dsh-model-connect',
  '@deepseek-ai/dsh-agent-preset-registry',
]
const REQUIRED = [
  '@deepseek-ai/dsh-persona',
  '@deepseek-ai/dsh-skill-filesystem',
  '@deepseek-ai/dsh-tool-skill',
]

for (const declaration of declared) {
  const names = pluginRows.map(row => row.name)
  for (const forbidden of FORBIDDEN) {
    if (names.includes(forbidden)) {
      failures.push(
        `preset row "${forbidden}" must not be mounted here: the host composition already mounts it, `
        + 'and a second apply() re-registers its subagent providers / settings / routes',
      )
    }
  }
  for (const required of REQUIRED) {
    if (!names.includes(required)) failures.push(`missing required row: ${required}`)
  }
  const seen = new Map()
  for (const name of names) seen.set(name, (seen.get(name) ?? 0) + 1)
  const repeated = [...seen].filter(([, count]) => count > 1).map(([name, count]) => `${name} ×${count}`)
  if (repeated.length > 0) notes.push(`package declared more than once (legal — distinct tool names — but check intent): ${repeated.join(', ')}`)

  const skillRow = pluginRows.find(row => row.name === '@deepseek-ai/dsh-skill-filesystem')
  const dirs = skillRow === undefined ? undefined : (doc.flatMap(row => row?.insert ?? []).flatMap(row => row?.config?.plugins ?? []).find(row => row?.name === '@deepseek-ai/dsh-skill-filesystem')?.config?.customSkillDirs)
  if (!Array.isArray(dirs) || dirs.length === 0) notes.push('skill-filesystem declares no customSkillDirs — this preset ships no skill of its own')
  else for (const dir of dirs) notes.push(`customSkillDirs entry: ${typeof dir === 'string' ? dir : `!!js ${String(dir?.__jsExpr)}`}`)
}

// Every tool name in the catalog must be unique; a duplicate would throw inside
// the layer at mount time and take the whole preset down.
const toolNames = []
for (const row of pluginRows) {
  if (row.name === '@deepseek-ai/dsh-tool-subagent' || row.name === '@deepseek-ai/dsh-tool-subagent-control') continue
  toolNames.push(row.name)
}

notes.push(`preset id(s): ${declared.map(d => JSON.stringify(d.id)).join(', ') || '(none)'}`)
notes.push(`declared plugin packages: ${pluginRows.length}`)
if (declared.length === 1) notes.push(`order: ${String(declared[0].order)} (shipped standard=1, cordis/code/minimal before this)`)

for (const note of notes) console.log(`note  ${note}`)
for (const failure of failures) console.error(`FAIL  ${failure}`)

if (failures.length === 0) {
  console.log(`\nOK  ${patchPath}\n    loads in the host's own YAML dialect and matches the preset shape contract`)
  process.exit(0)
}
console.error(`\n${failures.length} problem(s) — the host would reject this preset`)
process.exit(1)
