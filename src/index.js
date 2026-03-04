#!/usr/bin/env node

import { Command } from 'commander';
import * as inquirer from '@inquirer/prompts';
import { execa } from 'execa';
import fs from 'node:fs/promises';
import path from 'node:path';
import chalk from 'chalk';

/**
 * @typedef {Object} AZReleaseVariable
 * @property {string} value Variable value.
 * @property {boolean} isSecret Whether the variable is marked as secret.
 */
/**
 * @typedef {Object} AZEnvironment
 * @property {string} name Environment name.
 * @property {number} id Environment id.
 * @property {Record<string, AZReleaseVariable>} variables Environment variables.
 */
/**
 * @typedef {Object} AZReleaseDefinition
 * @property {string} name Release definition name.
 * @property {number} id Release definition id.
 * @property {AZEnvironment[]} environments List of environments in the release definition.
 */

/**
 * Creates a set of CLI style helpers.
 *
 * @param {import('chalk').ChalkInstance} chalkInstance Chalk instance used for styling.
 * @returns {{ error: (message: string) => string }} Style helper functions.
 */
const createCliStyles = (chalkInstance) => ({
  error: (message) => chalkInstance.redBright(message),
});

const CLI_STYLES = createCliStyles(chalk);

/**
 * Formats an error for display in the CLI.
 *
 * @param {{ error: (message: string) => string }} styles Style helpers.
 * @param {unknown} err Error-like value.
 * @returns {string} Formatted error string.
 */
const formatCliError = (styles, err) => styles.error(err?.message || err);

/**
 * Detects whether an error indicates the Azure CLI is not installed.
 *
 * @param {any} err Error thrown from executing `az`.
 * @returns {boolean} True if `az` appears missing.
 */
function isAzNotInstalledError(err) {
  // Windows: spawn az ENOENT, POSIX: ENOENT
  return err?.code === 'ENOENT' || /spawn\s+az\s+enoent/i.test(err?.message || '');
}

/**
 * Detects whether an error indicates Azure DevOps CLI authentication failure.
 *
 * @param {any} err Error thrown from executing `az devops`.
 * @returns {boolean} True if the error appears auth-related.
 */
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

/**
 * Wraps an Azure CLI execution error with a friendlier message.
 *
 * @param {string[]} args Azure CLI args (excluding the `az` binary).
 * @param {any} err Error thrown from executing `az`.
 * @returns {Error} Wrapped error.
 */
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

/**
 * Executes an Azure CLI command and parses its JSON output.
 *
 * @param {string[]} args Azure CLI args (excluding the `az` binary).
 * @param {{ cwd?: string } | undefined} [options] Execution options.
 * @returns {Promise<any>} Parsed JSON output.
 */
async function azJson(args, { cwd } = {}) {
  try {
    const finalArgs = [...args, '--output', 'json'];
    const { stdout } = await execa('az', finalArgs, { cwd });
    return JSON.parse(stdout || 'null');
  } catch (err) {
    throw wrapAzError(args, err);
  }
}

/**
 * Executes an Azure CLI command and returns its stdout.
 *
 * @param {string[]} args Azure CLI args (excluding the `az` binary).
 * @param {{ cwd?: string } | undefined} [options] Execution options.
 * @returns {Promise<string>} Command stdout.
 */
async function azText(args, { cwd } = {}) {
  try {
    const { stdout } = await execa('az', args, { cwd });
    return stdout;
  } catch (err) {
    throw wrapAzError(args, err);
  }
}

/**
 * Prompts the user to choose an environment from a release definition.
 *
 * @param {AZReleaseDefinition} definition Azure DevOps release definition object.
 * @param {{ definitionId?: number | string } | undefined} [options] Options for error context.
 * @returns {Promise<AZEnvironment>} Selected environment object.
 */
async function promptForEnvironment(definition, { definitionId } = {}) {
  const envs = definition?.environments;
  if (!Array.isArray(envs) || envs.length === 0) {
    throw new Error(
      `No environments found in release definition${definitionId ? ` id ${definitionId}` : ''}.`
    );
  }

  const envIdOrIndex = await inquirer.select({
    message: 'Select an environment:',
    pageSize: 20,
    // Keep API order (no sorting)
    choices: envs.map((e, idx) => {
      const name = (e?.name && String(e.name).trim()) || '(unnamed environment)';
      const id = e?.id;
      const label = id !== undefined ? `${name} (id: ${id})` : name;
      const value = id !== undefined ? id : idx;
      return { name: label, value };
    }),
  });

  const selectedById = envs.find((e) => e?.id === envIdOrIndex);
  if (selectedById) return selectedById;

  if (Number.isInteger(envIdOrIndex) && envIdOrIndex >= 0 && envIdOrIndex < envs.length) {
    return envs[envIdOrIndex];
  }

  throw new Error('Selected environment could not be resolved.');
}

/**
 * Converts a variable map into `.env` file content.
 *
 * @param {Record<string, { value: string } | string | number | boolean | null | undefined>} vars Variables to serialize.
 * @returns {string} Dotenv formatted content.
 */
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

/**
 * Simplifies Azure release variables to a plain key/value object.
 *
 * @param {Record<string, { value: string } | string | number | boolean | null | undefined>} vars Azure release variables.
 * @returns {Record<string, any>} Simplified key/value object.
 */
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

/**
 * Ensures the Azure CLI and the azure-devops extension are available.
 *
 * @param {void} _ Unused.
 * @returns {Promise<void>} Resolves when checks pass.
 */
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

/**
 * Reads Azure DevOps defaults from `az devops configure -l`.
 *
 * @param {void} _ Unused.
 * @returns {Promise<{ organization?: string, project?: string }>} Current defaults.
 */
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

/**
 * Prompts for missing Azure DevOps defaults and persists them.
 *
 * @param {void} _ Unused.
 * @returns {Promise<{ organization?: string, project?: string }>} Resolved defaults.
 */
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

/**
 * Lists Azure DevOps release definitions for the configured project.
 *
 * @param {void} _ Unused.
 * @returns {Promise<Array<{ id: number, name: string }>>} Release definitions.
 */
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

/**
 * Fetches a single release definition by id.
 *
 * @param {number | string} id Release definition id.
 * @returns {Promise<AZReleaseDefinition>} Release definition.
 */
async function showReleaseDefinition(id) {
  return azJson(['pipelines', 'release', 'definition', 'show', '--id', String(id)]);
}



/**
 * Runs the interactive CLI flow.
 *
 * @param {void} _ Unused.
 * @returns {Promise<void>} Resolves when flow completes.
 */
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
  const selectedEnv = await promptForEnvironment(definition, { definitionId: defId });

  const envVars = selectedEnv.variables || {};
  const simplified = simplifyVars(envVars);

  const keys = Object.keys(simplified);
  if (keys.length === 0) {
    const envName = selectedEnv?.name ? `"${selectedEnv.name}" ` : '';
    throw new Error(`Selected environment ${envName}has no variables in definition id ${defId}.`);
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

/**
 * CLI entrypoint.
 *
 * @param {void} _ Unused.
 * @returns {Promise<void>} Resolves when the CLI finishes parsing.
 */
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
      console.error(formatCliError(CLI_STYLES, err));
      process.exitCode = 1;
    }
  });

  await program.parseAsync(process.argv);
}

main();
