# azdo-release-env

Interactive CLI that extracts environment variables from a selected Azure DevOps **Release** pipeline environment and exports them to `./.env` or `./env.json`.

## Disclaimer

This is a personal project and is not officially supported by Microsoft or Azure DevOps. This CLI requires the Azure CLI and Azure DevOps extension to be installed and authenticated. It reads the release definition and environment variables via the Azure DevOps REST API. It does not store or transmit any data outside of your local machine. Use at your own risk.

## Requirements

- Node.js
- Azure CLI installed (`az`)
  - https://learn.microsoft.com/cli/azure/install-azure-cli
- Azure DevOps extension installed
  - `az extension add --name azure-devops`
- Authenticated to Azure DevOps
  - `az devops login`
- Azure DevOps defaults (`organization` and `project`)
  - If missing, the CLI will prompt and set them via `az devops configure -d ...`.

## Install

```bash
npm install
```

(Optional) Make the command available on your machine:

```bash
npm link
```

## Usage

Run interactively:

```bash
npm start
```

Or (after `npm link`):

```bash
azdo-release-env
```

The CLI will prompt you to:

- Select a release pipeline definition
- Choose an export format (`.env` or JSON)
- Confirm writing to the current directory

### Output

- `.env` export writes `./.env`
- `JSON` export writes `./env.json`

## Notes

- The CLI prompts you to select an environment from the release definition.
- Variable groups are currently not included (only explicit environment `variables`).

## Troubleshooting

- If `az` is not installed, install Azure CLI first.
- If you see an authentication error, run `az devops login`.
