# Supply-chain scanning: PolinRider

This repository runs a malware scan in CI (`.github/workflows/malware-scan.yml`) against the **PolinRider** campaign, a supply-chain campaign attributed to North Korea-linked actors that was still spreading when this was written (November 2026). The scanner is `scripts/polinrider-scan.mjs`. It is plain Node with no dependencies, so it adds nothing to install and nothing for an attacker to tamper with through the package registry.

## What PolinRider does

From the sources below, as read on 2026-11-08:

- It appends an obfuscated JavaScript payload to build config files, after a run of whitespace so it is easy to miss. The most common targets are `postcss.config.mjs`, `tailwind.config.js` and `eslint.config.mjs`, and newer reports add `next`, `vite`, `webpack`, `vue`, `astro`, `gridsome` and `truffle` configs. The payload runs whenever a build tool loads the file.
- It has been seen hidden inside fake `.woff` and `.woff2` font files.
- The payload fetches a second stage from blockchain dead drops (TRON, Aptos and BSC accounts), decrypts it with a fixed XOR key and runs it with `eval`. This is the Beavertail infostealer family.
- It spreads from developers' machines. A script called `temp_auto_push.bat` (with a hidden `config.bat`) amends the last commit, keeps its original author and timestamp by changing the system clock, and force-pushes. **The visible commit history can therefore look clean.**
- A second entry route is a fake job-interview repository whose `.vscode/tasks.json` runs a download-and-execute command as soon as the folder is opened in VS Code.
- It also ships as malicious npm packages that impersonate Tailwind and PostCSS helpers.
- The actor has already rotated the obfuscator's signature once (two variants are documented), so signatures go stale.

## What the scan checks

| Check                                                                                                                                     | Why                                                                                                                      |
| ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Payload signatures of both known obfuscator variants, the injection tags, and the combinations of constants they use                      | The payload itself                                                                                                       |
| The blockchain addresses, XOR keys, bootstrap hosts and template id the payload talks to                                                  | Catches a variant whose obfuscation was rotated but whose infrastructure was not                                         |
| `temp_auto_push.bat`, `config.bat`, batch files that read the last commit date and time, and a `.gitignore` entry that hides `config.bat` | The propagation machinery                                                                                                |
| `.vscode/tasks.json` with `runOn: folderOpen`, and whether it runs `curl`, `bash`, `powershell` and the like                              | The fake-interview route                                                                                                 |
| `.woff` and `.woff2` files that do not start with the font signature                                                                      | Payloads hidden in fake fonts                                                                                            |
| Known malicious npm packages in `package.json` and in lockfiles, and install hooks that download or run code                              | The npm route                                                                                                            |
| Code after 100 or more spaces, very long lines, `eval` or writes to `global` in build config files                                        | Variant-independent signs, so a rotated signature can still be flagged                                                   |
| With `--history`, the fixed indicators in **every commit**, and any commit that ever contained the propagation script                     | The campaign rewrites history. CI checks out the full history and runs this on every push, pull request and every Monday |

Findings are `HIGH` (the build fails) or `warn` (shown, but the build passes unless `--strict`). The output names the file, line and rule, and never prints the content of a flagged file.

## Running it yourself

```bash
node scripts/polinrider-scan.mjs .            # files in the working tree
node scripts/polinrider-scan.mjs . --history  # plus every commit
node --test scripts/polinrider-scan.node-test.mjs   # the scanner's own tests
```

Exit code 0 means no high finding, 1 means a high finding, 2 means bad usage.

## What a clean result does and does not mean

A clean scan means **no known indicator was found**. It does not prove the repository is safe. It cannot see an unknown variant with new infrastructure and no config-file tell-tales, a compromised dependency that is not on the list, or a compromised developer machine. Run the scan on your own clone as well, and keep the lists current: they live at the top of `scripts/polinrider-scan.mjs` and come from the dossier below.

## If it reports a high finding

1. Do not run the project (no install, no build, no opening it in an editor that auto-runs tasks). Read the flagged file in a plain text viewer.
2. Treat the machine that last pushed as compromised: rotate every token, key and credential it could reach (GitHub, npm, cloud, wallets), starting with anything that was in the environment during a build.
3. Remove the payload, the propagation script, the `.gitignore` entry and any malicious dependency, and review recent force-pushes in the repository's activity.
4. Re-scan afterwards and again later. Cleaned repositories have been re-infected with the rotated variant.

## Related hardening (settings, not code)

- **Branch protection that blocks force-pushes** on the default branch. The campaign force-pushes, so this turns a silent history rewrite into a failed push.
- Require pull requests and the CI checks (including this scan) before merging.
- Treat unknown "take-home" or interview repositories as hostile: open them in a throwaway virtual machine or container, and decline VS Code's prompt to trust the workspace.
- Review `postinstall` scripts before adding a dependency, and prefer pinned, locked versions.

## Sources

- OpenSourceMalware, [PolinRider dossier](https://github.com/OpenSourceMalware/PolinRider): the indicators used here, and a shell scanner covering the original variant only.
- Socket, [PolinRider: North Korea-linked supply chain campaign expands across open source ecosystems](https://socket.dev/blog/polinrider-north-korea-linked-supply-chain-campaign-expands).
- Socket, [PolinRider spreads through compromised GitHub accounts and Packagist](https://socket.dev/blog/polinrider-github-packagist).
- Wiz, [PolinRider campaign: DPRK-linked supply chain attack infects GitHub repositories](https://threats.wiz.io/all-incidents/polinrider-campaign-dprk-linked-supply-chain-attack-infects-github-repositories).
