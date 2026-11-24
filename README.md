# n8n-nodes-removebackground

An n8n community node for [removebackground.dev](https://removebackground.dev): remove the background from images in your workflows and check your credit balance.

[Installation](#installation) · [Credentials](#credentials) · [Operations](#operations) · [Compatibility](#compatibility) · [Resources](#resources)

## Installation

In n8n, open **Settings → Community Nodes → Install**, enter `n8n-nodes-removebackground` and confirm. See n8n's [community node installation guide](https://docs.n8n.io/integrations/community-nodes/installation/) for self-hosted setups and the manual `npm install` route.

## Credentials

1. Sign in at [removebackground.dev](https://removebackground.dev) and create an API key under [API keys](https://removebackground.dev/api-keys).
2. In n8n, add a **removebackground.dev API** credential and paste the key.

The key is sent in the `X-Api-Key` header. Saving the credential checks it against the free account endpoint (`GET /v1.0/account`).

## Operations

### Remove Background

Removes the background from one image per input item. Costs 1 credit per successful image.

- **Input Source**: *Binary File* (the input binary field, default `data`) or *Image URL* (a public JPG, PNG or WebP URL).
- **Output Binary Field**: where the result image goes (default `data`). The file is named after the original, for example `photo-no-bg.png`.
- **Options**
  - **Format**: PNG (default), JPG or WebP. JPG has no transparency.
  - **Background Color**: fill the background instead of leaving it transparent.
  - **Size**: Full (original resolution, default), HD, Medium or Preview.
  - **Crop to Subject**: crop the result to the subject.

The JSON output holds `width`, `height`, `credits_remaining`, `format`, `file_name`, `job_id` and `removal_id`.

Most images come back within the first request. When one takes longer, the API answers with a job; the node polls it every 2 seconds for up to 2 minutes and then downloads the result.

### Get Credits

Returns the account's remaining credits as `{ "credits": 42 }`. Free.

### Errors

API errors are shown with the API's message and code (for example `insufficient_credits` or `unauthorized`). With **Continue On Fail** on, the item gets an `error` field instead of stopping the workflow.

The node can also be used as a tool by n8n's AI Agent.

## Compatibility

Built with `@n8n/node-cli` 0.53.4 against `n8n-workflow` 2.44. No runtime dependencies.

## Development

```bash
npm install
npm run lint
npm run build
npm run dev   # starts n8n with the node linked
```

Publishing runs from GitHub Actions (`.github/workflows/n8n-node.yml` at the repository root): bump `version` in `package.json`, merge to `main`, and the workflow publishes that version to npm with provenance.

## Resources

- [removebackground.dev API reference](https://removebackground.dev/api)
- [OpenAPI document](https://removebackground.dev/openapi.json)
- [n8n community nodes documentation](https://docs.n8n.io/integrations/#community-nodes)
