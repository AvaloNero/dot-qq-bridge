# Reference review

The bridge is implemented from public protocol specifications using Node.js built-in modules and the MIT `ws@8.21.0` runtime dependency, downloaded from the official npm registry with lifecycle scripts disabled. Its exact version and integrity are locked in `package-lock.json`; its copyright and license are preserved in [licenses/ws-MIT.txt](licenses/ws-MIT.txt). No optional native peers are installed. The repository's existing MIT LICENSE is unchanged.

Reviewed, without importing or bundling runtime source:

- Tencent Connect's [openclaw-qqbot](https://github.com/tencent-connect/openclaw-qqbot), commit `a730701d36aa7a070f98d4cba0f340f91f15e5f5`, MIT, copyright notice naming sliverp / Tencent Connect (see its [LICENSE](https://github.com/tencent-connect/openclaw-qqbot/blob/a730701d36aa7a070f98d4cba0f340f91f15e5f5/LICENSE)).
- `@tencent-connect/qqbot-nodejs@1.0.4`, published package metadata declares MIT; downloaded only for static protocol review from `registry.npmjs.org` with lifecycle scripts disabled. Integrity recorded in [docs/tencent-reference.md](docs/tencent-reference.md).
- `@tencent-connect/qqbot-connector@1.2.0`: package metadata declares `UNLICENSED`, with no LICENSE file. Downloaded outside the repository only for README, public type declarations, package metadata and file-list review. Its runtime code is not copied, imported, installed, bundled or executed. The prepared callback interface is our implementation against the published API contract; real use requires a separately reviewed grant and owner authorization. See [docs/connection.md](docs/connection.md).
- [Standard Webhooks specification](https://github.com/standard-webhooks/standard-webhooks/blob/main/spec/standard-webhooks.md) and the MCP/OpenAI/QQ protocol sources linked in [docs/protocol.md](docs/protocol.md). No Standard Webhooks library source is bundled.

The deployment template uses the [official Node Docker image](https://github.com/nodejs/docker-node). No image was built or redistributed during this work. A future deployed image carries its own operating-system and Node component licenses; retain those notices when distributing it.
