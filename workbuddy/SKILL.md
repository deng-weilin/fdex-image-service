---
name: fdex-image-studio
description: Use the shared FDEX image service to inspect balance, prepare a drawing spec, generate a new product illustration, edit an existing generated version, and query the same job until it finishes.
---

# FDEX Image Studio

Use the configured `fdex-image` MCP server. It calls the same account, wallet, jobs, images, and ledger as the web application. Never calculate or edit Credits locally, and never place a provider key in this skill.

## Workflow

1. Call `get_balance` before the first paid action. Tell the user the current fixed generate price and edit price.
2. Call `list_assets` when the user refers to uploaded material. Gather product facts into `prepare_drawing_spec`; pass selected asset IDs as `input_asset_ids`. Preserve unknown dimensions and installation offsets as unknowns. Never invent a dimension because a reference image shows it.
3. For a new illustration, confirm the current generate price and the single-image scope, then call `generate_image` with `confirm_charge: true` only when the user has clearly requested that action.
4. For an adjustment, call `list_images` and identify the exact parent version. Confirm the edit price, modification, and items to preserve, then call `edit_image` with `confirm_charge: true`.
5. If a job is still queued or running, call `get_image_job` with the same job ID. Do not submit the operation again. A `reconciling` job has an unknown provider outcome and must not be retried automatically.
6. Return the generated image, version number, parent version, job ID, provider mode, and charged price. Image text and technical dimensions require human review.

## Guardrails

- A new generation may use uploaded references, but an external reference image is not an editable generated parent.
- An edit must use an image returned by this service and owned by the authenticated user.
- If a client rejects an image block or reports a transport error after submission, do not submit again. Call `get_image_job`, `list_images`, or `get_balance` first and reconcile whether the job already succeeded and charged.
- The server also merges identical requests submitted within a short window, but this is a safety net rather than permission to click or call twice.
- `IMAGE/SVG+XML` results are returned as text plus `contentUrl` because the client only accepts raster image blocks. Open that URL; do not retry the paid task merely because SVG was not embedded.
- Never submit multiple candidates, additional edits, or retries unless the user explicitly requests and confirms the extra paid action.
- The difference between `mock` and `live` is part of the result. Do not describe a mock result as a live provider call.
- If authentication, ownership, balance, or provider configuration fails, report the actual API error. Do not bypass the backend.
