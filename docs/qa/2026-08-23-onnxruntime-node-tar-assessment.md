# Packaged `onnxruntime-node` to `node-tar` assessment

Assessment date: 2026-08-23

Scope: the exact macOS packaged dependency finding from the full-product
hardening verification, not the other production-tree advisories.

Snapshot boundary: the dependency and reachability findings below describe the
pre-remediation `develop` commit
`a2be0798335e3a1cc098943628911d4f30d95d59`, which resolved `tar@7.5.16` when
rechecked on 2026-08-31.

Resolution note: PR #1066 merged at `a5a64b25`. The root override and lockfile
pin `tar` at `7.5.21`, closing the original critical
`onnxruntime-node` to `node-tar` advisory chain. The historical reachability
analysis remains below because it records the pre-remediation risk boundary.

## Decision

In the pre-remediation snapshot, the critical `node-tar` advisory was **shipped
but not demonstrated reachable from untrusted pilot input on macOS**.

That evidence did not establish an emergency remote exploit in Tovi's product
path. PR #1066 has now removed this specific critical advisory from the
integrated dependency tree by resolving `tar@7.5.21`. The wider production audit
remains nonzero, and the merge does not replace native transcription or signed
package verification.

## Dependency and runtime path

The chain in the `a2be0798` snapshot is:

```text
@inbox-os/runner
  -> @huggingface/transformers@3.8.1
     -> onnxruntime-node@1.21.0
        -> tar@7.5.16 in the verified package
```

The runner also declares `onnxruntime-node@1.21.0` directly so the runtime is
deduplicated. `@huggingface/transformers@3.8.1` pins that exact ONNX version.

Tovi's application runtime does not import `tar`. It lazy-imports Transformers
only when local transcription is enabled and processes PCM audio through the
ONNX binding:

- `apps/runner/src/services/transcription/transformers-whisper-provider.ts`
- `scripts/fetch-whisper-model.mjs`

Neither path accepts an archive or forwards an archive path to `node-tar`.

## Why `tar` is present

The published `onnxruntime-node@1.21.0` package declares:

```json
{
  "scripts": { "postinstall": "node ./script/install" },
  "dependencies": { "tar": "^7.0.1" }
}
```

Its install script imports `tar` at module load. The extraction call is reached
only when installing CUDA binaries for Linux x64. The URL is constructed from
the fixed ONNX Runtime GitHub release and package version. Normal macOS install
exits before download/extraction, and the signed app does not execute the
postinstall script during normal runtime.

The macOS packaging prune keeps only the current Darwin ONNX binary, but it does
not remove `onnxruntime-node/script` or the transitive `tar` module. That is why
the vulnerability remains visible in a package built from `a2be0798`, even
though the application path does not use it.

## Threat assessment

| Question | Evidence-backed answer |
| --- | --- |
| Can a message, attachment, model response, or dashboard request supply an archive to this code? | No product path was found. Tovi never imports the ONNX install script or `tar`. |
| Is archive extraction part of macOS packaged runtime? | No. It is an npm postinstall concern and the extraction branch is Linux x64/CUDA-specific. |
| Does a package built from `a2be0798` ship vulnerable code? | Yes. The package and transitive module remain under `node_modules` in the signed app. |
| Could a local attacker who already executes arbitrary packaged Node code call it? | Yes, but that attacker already has code execution in Tovi's local process context. This is not a new remote trust boundary. |
| Is the advisory safely ignorable forever? | No. Reachability can change, future packaging may target Linux, and a red critical production audit weakens release assurance. |

Assessment at the pre-remediation boundary: **not a standalone blocker for the
narrow macOS student pilot on the recorded reachability evidence**. The tested
dependency correction is now integrated. If any future code accepts untrusted
archives or invokes the install script at runtime, reassess the boundary
immediately.

## Corrective status on 2026-08-31

The preferred minimal remediation is to keep the existing ONNX and Transformers
versions and resolve their declared `tar` dependency to `tar@7.5.21`. This is an
in-range patch update for every current consumer:

- `onnxruntime-node@1.21.0` declares `tar@^7.0.1`.
- `app-builder-lib@26.15.3` declares `tar@^7.5.7`.
- `node-gyp@12.4.0` declares `tar@^7.5.4`.

Commit `44a93903613a87ac5af17bfba2100557cef3b0a1` on
`fix/dependency-tar-security` adds an exact root override and lockfile resolution
for `tar@7.5.21`. Independent review recorded PASS with this evidence:

- the lock contains one `tar` package, at `7.5.21`;
- `npm explain tar` resolves all three consumers to that package without an
  invalid dependency;
- `npm audit --omit=dev` no longer reports a `tar` advisory, although the wider
  production audit remains nonzero because of unrelated dependencies;
- 25 focused dependency, macOS packaging, Windows packaging, and transcription
  selection tests pass.

PR #1066 merged this correction into `develop` at
`a5a64b25b08946d10d1e08d91bc63d17c65f26d5`. The current `origin/develop` lock
at `33896960` still contains `tar@7.5.21`. The PR evidence records zero critical
production advisories after the change, with 18 high and 4 moderate advisories
remaining outside this focused remediation. Before broader pilot or production
distribution, retain the remaining release evidence listed below.

## Longer-term dependency options

Registry metadata checked on 2026-08-23 shows:

- `onnxruntime-node@1.21.0` depends on `tar`.
- `onnxruntime-node@1.22.0` replaces `tar` with `adm-zip`.
- `@huggingface/transformers@3.8.1` pins `onnxruntime-node@1.21.0`.
- The first later stable Transformers line is `4.0.0`, which depends on
  `onnxruntime-node@1.24.3`; current latest is Transformers `4.2.0` and ONNX
  Runtime `1.27.0`.

These upgrades are not the preferred immediate correction now that a supported
in-range `tar` update is available. They remain longer-term maintenance options.
Changing only Tovi's direct ONNX dependency is insufficient unless the package
manager deliberately overrides Transformers' exact dependency. The two credible
experiments are:

1. Override ONNX Runtime to `1.22.0` and prove Transformers 3.8.1 model loading,
   transcription output, native packaging, and macOS/Windows binary selection.
2. Upgrade Transformers to a 4.x release and revalidate the complete local
   transcription contract, model cache, memory/latency, and packaged footprint.

The first is the smaller change but is an unsupported dependency substitution
until tested. The second follows upstream's declared dependency but has a much
larger API and model-behaviour surface.

Do not run `npm audit fix` blindly. Before broader distribution, require:

- exact production-tree audit output;
- one real local model download/initialisation in isolated storage;
- deterministic known-audio transcription comparison;
- runner transcription tests;
- signed packaged first launch and transcription;
- macOS arm64 and Windows x64 packaging checks;
- package-size and memory comparison.

## Primary evidence

- Published `onnxruntime-node@1.21.0` package metadata and install script from
  the npm registry.
- npm registry dependency metadata for ONNX Runtime 1.21.0/1.22.0 and
  Transformers 3.8.1/4.0.0/4.2.0.
- [`GHSA-23hp-3jrh-7fpw`](https://github.com/advisories/GHSA-23hp-3jrh-7fpw).
- `package-lock.json`, `apps/runner/package.json`,
  `scripts/build-macos-dmg.mjs`, and the runtime transcription sources in this
  repository.
