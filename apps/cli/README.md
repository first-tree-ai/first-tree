# First Tree CLI

First Tree is the unified CLI for Context Tree onboarding, agent management, and team messaging.

Install the production CLI (macOS or Linux):

```bash
curl -fsSL --proto '=https' --proto-redir '=https' https://download.first-tree.ai/releases/prod/install.sh | sh
```

After the installer completes successfully, connect this computer with a short
code from the First Tree web console:

```bash
~/.local/bin/first-tree login <connect-code>
```

The binary is `first-tree`; the short alias `ft` is installed with it.

For staging, use the staging installer and binary:

```bash
curl -fsSL --proto '=https' --proto-redir '=https' https://download.first-tree.ai/releases/staging/install.sh | sh
```

After the installer completes successfully, connect with the staging binary:

```bash
~/.local/bin/first-tree-staging login <connect-code>
```

## Documentation

- [Quickstart](https://github.com/agent-team-foundation/first-tree/blob/main/docs/quickstart.md)
- [Onboarding Guide](https://github.com/agent-team-foundation/first-tree/blob/main/docs/onboarding-guide.md)
- [CLI Reference](https://github.com/agent-team-foundation/first-tree/blob/main/docs/cli-reference.md)
- [Troubleshooting](https://github.com/agent-team-foundation/first-tree/tree/main/docs/troubleshooting)

## Links

- [Source repository](https://github.com/agent-team-foundation/first-tree)
- [Issues](https://github.com/agent-team-foundation/first-tree/issues)
- [First Tree](https://first-tree.ai)

## License

Apache-2.0. See [LICENSE](https://github.com/agent-team-foundation/first-tree/blob/main/LICENSE).
