# Reference review

The bridge is implemented from public protocol specifications using Node.js built-in modules. It has no installed or bundled third-party runtime dependencies. The repository's existing MIT LICENSE is unchanged.

Reviewed, without importing or bundling runtime source:

- Tencent Connect's [openclaw-qqbot](https://github.com/tencent-connect/openclaw-qqbot), commit `a730701d36aa7a070f98d4cba0f340f91f15e5f5`, MIT, copyright notice naming sliverp / Tencent Connect (see its [LICENSE](https://github.com/tencent-connect/openclaw-qqbot/blob/a730701d36aa7a070f98d4cba0f340f91f15e5f5/LICENSE)).
- `@tencent-connect/qqbot-nodejs@1.0.4`, published package metadata declares MIT; downloaded only for static protocol review from `registry.npmjs.org` with lifecycle scripts disabled. Integrity recorded in [docs/tencent-reference.md](docs/tencent-reference.md).
- [Standard Webhooks specification](https://github.com/standard-webhooks/standard-webhooks/blob/main/spec/standard-webhooks.md) and the MCP/OpenAI/QQ protocol sources linked in [docs/protocol.md](docs/protocol.md). No Standard Webhooks library source is bundled.

The deployment template uses the [official Node Docker image](https://github.com/nodejs/docker-node). No image was built or redistributed during this work. A future deployed image carries its own operating-system and Node component licenses; retain those notices when distributing it.
