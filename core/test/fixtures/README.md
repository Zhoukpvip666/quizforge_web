# Legacy regression fixtures

`legacy-extensions/` preserves prior published packages for compatibility and upgrade tests. `legacy-banks/` preserves duplicate historical demos used by those tests. These directories are not loaded by the application catalog.

The small modules under `core/shared/richtext/` re-export the active shared document validators so the relocated packages keep their original source import paths. Released fixture files and bundled rules are preserved byte for byte; historical build and demo scripts write here only when explicitly invoked.

The following regression sources were copied from Git commit `9a59e346b1ffd188358ed9e3b1919aed7568d388` on 2026-10-11 using raw `git ls-tree` and `git show` bytes. These copies preserve the original manifest, schemas, scripts, markup, styles, examples and images; no released file was rewritten.

| Fixture directory | Original tracked directory | Files |
| --- | --- | ---: |
| `legacy-extensions/single-choice-1.0.0/` | `extensions/基础题型/single-choice/` | 12 |
| `legacy-extensions/short-answer-1.3.0/` | `extensions/基础题型/short-answer-1.3.0/` | 16 |
| `legacy-banks/short-answer-demo/` | `question-banks/short-answer-demo/` | 2 |
| `legacy-banks/mixed-demo/` | `question-banks/mixed-demo/` | 1 |

The regression tests read these fixed sources even when the corresponding installed packages or demonstration banks have been removed. Java's `InstalledExtensionFixtures.find` verifies the expected ID and version before returning these two released extension fixtures. Production `extensions/` and `question-banks/` remain independent of this test data.
