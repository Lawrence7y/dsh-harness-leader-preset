#!/usr/bin/env node
/**
 * Resolve the skill path EXACTLY the way the running host will.
 *
 * The `customSkillDirs` entry in `cordis.patch.yml` is a `!!js` expression the
 * Loader evaluates when the preset row activates, with `baseUrl` in scope. This
 * script parses that expression out of the real file, evaluates it under each
 * plausible runtime, and reports where the skill directory lands — so a broken
 * path surfaces here instead of as a silently empty skill catalog.
 *
 * Usage: node resolve-skill-path.mjs
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const yamlPath = join(here, '.preset-validate', 'node_modules', 'js-yaml', 'index.js')
if (!existsSync(yamlPath)) {
  console.error('missing js-yaml; run tools/extract-asar.mjs first (see validate-preset.mjs)')
  process.exit(2)
}

const yaml = await import(pathToFileURL(yamlPath).href)
const loadYaml = yaml.load ?? yaml.default?.load
const JsExpr = new yaml.Type('tag:yaml.org,2002:js', {
  kind: 'scalar',
  resolve: data => typeof data === 'string',
  construct: data => ({ __jsExpr: data }),
})
const doc = loadYaml(readFileSync(join(here, 'cordis.patch.yml'), 'utf8'), { schema: yaml.JSON_SCHEMA.extend(JsExpr) })

/** Depth-first walk over patch rows, groups and preset child rows. */
function* rows(entries) {
  for (const row of entries ?? []) {
    if (row === null || typeof row !== 'object') continue
    yield row
    if (Array.isArray(row.insert)) yield* rows(row.insert)
    if (Array.isArray(row.config)) yield* rows(row.config)
    if (Array.isArray(row.config?.plugins)) yield* rows(row.config.plugins)
  }
}

const skillRow = [...rows(doc)].find(row => row.name === '@deepseek-ai/dsh-skill-filesystem')
const expressions = skillRow?.config?.customSkillDirs
if (!Array.isArray(expressions) || expressions.length === 0) {
  console.error('no customSkillDirs on the skill-filesystem row')
  process.exit(1)
}

const PACKAGE = '@dsh-external/dsh-harness-leader-preset'
const profileDir = process.env.DSH_PROFILE_DIR ?? 'C:/Users/Administrator/.dsh/profiles/desktop'
const dshHome = process.env.DSH_HOME ?? 'C:/Users/Administrator/.dsh'

/** The runtimes that could be standing in for `baseUrl`, most likely first. */
const runtimes = [
  { label: 'baseUrl = bundle root (file:)', baseUrl: pathToFileURL(join(here, 'cordis.patch.yml')).href },
  { label: 'baseUrl = profile dir', baseUrl: profileDir },
  { label: 'baseUrl = profile dir (file:)', baseUrl: pathToFileURL(join(profileDir, 'cordis.patch.yml')).href },
  { label: 'baseUrl = dsh home', baseUrl: dshHome },
  { label: 'baseUrl = dsh app dir', baseUrl: 'D:/DeepSeek/resources/app.asar/dsh' },
  { label: 'baseUrl undefined', baseUrl: undefined },
]

let ok = 0
for (const expression of expressions) {
  if (typeof expression !== 'object' || typeof expression.__jsExpr !== 'string') {
    console.error(`customSkillDirs entry is not a !!js expression: ${String(expression)}`)
    process.exit(1)
  }
  console.log(`expression: !!js ${expression.__jsExpr}\n`)
  for (const runtime of runtimes) {
    // `baseUrl` is the only free variable the Loader puts in scope; pass it the
    // way a `with`-style evaluation would, without relying on indirect eval.
    const evaluate = new Function('baseUrl', 'process', `return (${expression.__jsExpr})`)
    let result
    try {
      result = evaluate(runtime.baseUrl, process)
    } catch (error) {
      console.log(`  ${runtime.label.padEnd(34)} THREW  ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`)
      continue
    }
    const exists = typeof result === 'string' && existsSync(result)
    const skillFile = typeof result === 'string' ? join(result, 'external-harness-coordination', 'SKILL.md') : ''
    const hasSkill = skillFile !== '' && existsSync(skillFile)
    const marker = hasSkill ? 'OK   ' : exists ? 'DIR  ' : 'MISS '
    console.log(`  ${runtime.label.padEnd(34)} ${marker} ${String(result)}`)
    if (hasSkill) ok += 1
  }
}

/** Independently confirm the package is resolvable the way the fallback does. */
try {
  const resolved = createRequire(join(profileDir, 'package.json')).resolve(`${PACKAGE}/package.json`)
  console.log(`\nprofile node_modules resolves ${PACKAGE} → ${resolved}`)
} catch (error) {
  console.log(`\nprofile node_modules does NOT resolve ${PACKAGE} yet (${error.code}); install the bundle first`)
}

console.log(ok > 0 ? '\nOK  the expression yields a real skill directory' : '\nFAIL  no runtime produced an existing skill directory')
process.exit(ok > 0 ? 0 : 1)
