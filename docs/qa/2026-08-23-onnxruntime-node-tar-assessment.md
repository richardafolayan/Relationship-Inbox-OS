# Packaged `onnxruntime-node` to `node-tar` assessment

Assessment date: 2026-08-23

Scope: the exact macOS packaged dependency finding from the full-product
hardening verification, not the other production-tree advisories.

## Decision

The critical `node-tar` advisory is **shipped but not demonstrated reachable
from untrusted pilot input on macOS**.

It is not evidence of an emergency remote exploit in Tovi's current product
path. It is still release debt: vulnerable code is present in the signed app,
the package audit remains red, and the dependency should be removed or upgraded
deliberately before broader distribution.

## Dependency and runtime path

The shipped chain is:

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
the vulnerability remains visible in the packaged production audit even though
the application path does not use it.

## Threat assessment

| Question | Evidence-backed answer |
| --- | --- |
| Can a message, attachment, model response, or dashboard request supply an archive to this code? | No product path was found. Tovi never imports the ONNX install script or `tar`. |
| Is archive extraction part of macOS packaged runtime? | No. It is an npm postinstall concern and the extraction branch is Linux x64/CUDA-specific. |
| Does vulnerable code still ship? | Yes. The package and transitive module remain under `node_modules` in the signed app. |
| Could a local attacker who already executes arbitrary packaged Node code call it? | Yes, but that attacker already has code execution in Tovi's local process context. This is not a new remote trust boundary. |
| Is the advisory safely ignorable forever? | No. Reachability can change, future packaging may target Linux, and a red critical production audit weakens release assurance. |

Assessment: **not a standalone blocker for the narrow macOS student pilot on
current reachability evidence**, but it must be tracked and removed through a
tested dependency change. If any future code accepts untrusted archives or
invokes the install script at runtime, reclassify it immediately as a release
blocker.

## Minimum removal options

Registry metadata checked on 2026-08-23 shows:

- `onnxruntime-node@1.21.0` depends on `tar`.
- `onnxruntime-node@1.22.0` replaces `tar` with `adm-zip`.
- `@huggingface/transformers@3.8.1` pins `onnxruntime-node@1.21.0`.
- The first later stable Transformers line is `4.0.0`, which depends on
  `onnxruntime-node@1.24.3`; current latest is Transformers `4.2.0` and ONNX
  Runtime `1.27.0`.

Therefore, changing only Tovi's direct ONNX dependency is insufficient unless
the package manager is deliberately overriding Transformers' exact dependency.
The two credible experiments are:

1. Override ONNX Runtime to `1.22.0` and prove Transformers 3.8.1 model loading,
   transcription output, native packaging, and macOS/Windows binary selection.
2. Upgrade Transformers to a 4.x release and revalidate the complete local
   transcription contract, model cache, memory/latency, and packaged footprint.

The first is the smaller change but is an unsupported dependency substitution
until tested. The second follows upstream's declared dependency but has a much
larger API and model-behaviour surface.

Do not run `npm audit fix` blindly. Use a dedicated dependency branch and require:

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
