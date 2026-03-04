#!/usr/bin/env node

import { Command } from 'commander';
import * as inquirer from '@inquirer/prompts';
import { execa } from 'execa';
import fs from 'node:fs/promises';
import path from 'node:path';

function isAzNotInstalledError(err) {
  // Windows: spawn az ENOENT, POSIX: ENOENT
  return err?.code === 'ENOENT' || /spawn\s+az\s+enoent/i.test(err?.message || '');
}

function isAzDevopsAuthError(err) {
  const msg = `${err?.stderr || ''}\n${err?.message || ''}`.toLowerCase();
  // Common messages:
  // - "Please run 'az devops login'"
  // - "TF400813: The user ... is not authorized"
  // - "Authentication failed"
  return (
    msg.includes('az devops login') ||
    msg.includes('authentication failed') ||
    msg.includes('not authorized') ||
    msg.includes('authorization') ||
    msg.includes('tf400813')
  );
}

function wrapAzError(args, err) {
  if (isAzNotInstalledError(err)) {
    const e = new Error(
      "Azure CLI (az) was not found. Install it first: https://learn.microsoft.com/cli/azure/install-azure-cli"
    );
    e.cause = err;
    return e;
  }

  if (isAzDevopsAuthError(err)) {
    const e = new Error(
      "Azure DevOps CLI authentication is missing/expired. Run: az devops login"
    );
    e.cause = err;
    return e;
  }

  const details = err?.stderr || err?.shortMessage || err?.message || String(err);
  const wrapped = new Error(`Azure CLI command failed: az ${args.join(' ')}\n${details}`);
  wrapped.cause = err;
  return wrapped;
}

async function azJson(args, { cwd } = {}) {
  try {
    const finalArgs = [...args, '--output', 'json'];
    const { stdout } = await execa('az', finalArgs, { cwd });
    return JSON.parse(stdout || 'null');
  } catch (err) {
    throw wrapAzError(args, err);
  }
}

async function azText(args, { cwd } = {}) {
  try {
    const { stdout } = await execa('az', args, { cwd });
    return stdout;
  } catch (err) {
    throw wrapAzError(args, err);
  }
}

function normalizeEnvName(name) {
  return String(name || '').trim().toLowerCase();
}

function isDevEnvName(name) {
  const n = normalizeEnvName(name);
  return n === 'dev' || n === 'development';
}

function toDotenv(vars) {
  // vars: Record<string, { value: string } | string>
  // We will output KEY=VALUE, quoting when necessary.
  const lines = [];
  for (const [key, raw] of Object.entries(vars)) {
    const value = raw && typeof raw === 'object' && 'value' in raw ? raw.value : raw;

    if (value === null || value === undefined) {
      lines.push(`${key}=`);
      continue;
    }

    const str = String(value);

    // Quote if contains spaces, #, quotes, or newlines.
    if (/[\s#"'\n\r]/.test(str)) {
      // Use double quotes; escape backslashes, double quotes, and newlines.
      const escaped = str
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')
        .replace(/\r/g, '\\r')
        .replace(/\n/g, '\\n');
      lines.push(`${key}="${escaped}"`);
    } else {
      lines.push(`${key}=${str}`);
    }
  }
  return lines.join('\n') + (lines.length ? '\n' : '');
}

function simplifyVars(vars) {
  // Azure release variables shape: { KEY: { value, isSecret, ... } }
  // We'll omit secrets? For now, include value if present.
  const out = {};
  for (const [key, v] of Object.entries(vars || {})) {
    if (v && typeof v === 'object' && 'value' in v) out[key] = v.value;
    else out[key] = v;
  }
  return out;
}

async function ensureAzAvailable() {
  // Dedicated check so we can surface a clearer message.
  try {
    await azText(['--version']);
  } catch (err) {
    throw err;
  }

  // Also validate azure-devops extension is available.
  // This will also catch auth issues in some setups, but mostly ensures az devops exists.
  await azText(['devops', '-h']);
}

async function getDevopsDefaults() {
  // Returns { organization, project } possibly undefined.
  // az devops configure -l output example (text):
  // organization=https://dev.azure.com/foo
  // project=bar
  const out = await azText(['devops', 'configure', '-l']);
  const defaults = {};
  for (const line of String(out || '').split(/\r?\n/)) {
    const m = line.match(/^\s*([^=]+)=(.*)\s*$/);
    if (!m) continue;
    const key = m[1].trim();
    const val = m[2].trim();
    if (key === 'organization') defaults.organization = val;
    if (key === 'project') defaults.project = val;
  }
  return defaults;
}

async function promptAndSetDevopsDefaultsIfMissing() {
  const defaults = await getDevopsDefaults();

  const questions = [];
  if (!defaults.organization) {
    questions.push({
      required: true,
      message: 'Azure DevOps organization URL (e.g., https://dev.azure.com/your-org):',
      validate: (v) => (String(v || '').trim() ? true : 'Organization is required'),
    });
  }
  if (!defaults.project) {
    questions.push({
      required: true,
      message: 'Azure DevOps project name:',
      validate: (v) => (String(v || '').trim() ? true : 'Project is required'),
    });
  }

  if (questions.length === 0) return defaults;

  questions.forEach(async (q) => {
    const anser = await inquirer.input(q);
  })

  const newDefaults = {
    organization: defaults.organization || answers.organization,
    project: defaults.project || answers.project,
  };

  // Persist defaults for subsequent az devops commands.
  await azText([
    'devops',
    'configure',
    '-d',
    `organization=${newDefaults.organization}`,
    `project=${newDefaults.project}`,
  ]);

  return newDefaults;
}

async function listReleaseDefinitions() {
  // Query trims output to id/name.
  return azJson([
    'pipelines',
    'release',
    'definition',
    'list',
    '--query',
    "[].{id:id,name:name}",
  ]);
}

async function showReleaseDefinition(id) {
  return azJson(['pipelines', 'release', 'definition', 'show', '--id', String(id)]);
}

function pickDevEnvironment(definition) {
  const envs = definition?.environments;
  if (!Array.isArray(envs)) return null;
  return envs.find((e) => isDevEnvName(e?.name)) || null;
}

async function runInteractive() {
  await ensureAzAvailable();
  await promptAndSetDevopsDefaultsIfMissing();

  /**
   * List release definitions
   * @type {Array<{id: number, name: string}>}
   */
  const defs = await listReleaseDefinitions();
  if (!defs || defs.length === 0) {
    throw new Error('No release definitions found in this Azure DevOps project.');
  }

  const defId = await inquirer.select({
    message: 'Select a release pipeline definition:',
    choices: defs
      .slice()
      .sort((a, b) => String(a.name).localeCompare(String(b.name)))
      .map((d) => ({
        name: `${d.name} (id: ${d.id})`,
        value: d.id,
      })),
      pageSize: 20,
  })

  const definition = await showReleaseDefinition(defId);
  const devEnv = pickDevEnvironment(definition);
  if (!devEnv) {
    const available = (definition?.environments || []).map((e) => e?.name).filter(Boolean);
    throw new Error(
      `No DEV/Development environment found in definition id ${defId}.` +
        (available.length ? ` Available environments: ${available.join(', ')}` : '')
    );
  }

  const envVars = devEnv.variables || {};
  const simplified = simplifyVars(envVars);

  const keys = Object.keys(simplified);
  if (keys.length === 0) {
    throw new Error(`DEV environment has no variables in definition id ${defId}.`);
  }
  
  const format = await inquirer.select({
    message: 'Export format:',
    choices: [
      { name: '.env', value: 'env' },
      { name: 'JSON', value: 'json' },
    ],
    default: 'env',
  })

  const cwd = process.cwd();
  const outPath =
    format === 'env' ? path.join(cwd, '.env') : path.join(cwd, 'env.json');

  const confirmWrite = await inquirer.confirm({
    message: `Write ${keys.length} variables to ${path.basename(outPath)} in current directory?`,
    default: true,
  })

  if (!confirmWrite) return;

  if (format === 'env') {
    await fs.writeFile(outPath, toDotenv(simplified), 'utf8');
  } else {
    await fs.writeFile(outPath, JSON.stringify(simplified, null, 2) + '\n', 'utf8');
  }

  // eslint-disable-next-line no-console
  console.log(`Wrote ${keys.length} variables to ${outPath}`);
}

async function main() {
  const program = new Command();

  program
    .name('azdo-release-env')
    .description(
      'Extract DEV/Development environment variables from Azure DevOps release pipelines'
    )
    .version('1.0.0');

  program.action(async () => {
    try {
      await runInteractive();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(err?.message || err);
      process.exitCode = 1;
    }
  });

  await program.parseAsync(process.argv);
}

main();
