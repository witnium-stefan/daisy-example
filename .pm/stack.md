# Stack

- Tiny Node (or Go) services, digest-pinned images on `ghcr.io/witnium` (publish token: repository secret `GHCR_PUBLISH_TOKEN`, account witnium, write:packages).
- Compose file that Opsie Daisy intake accepts today (compose-file and repository source kinds; GHCR images only; digest-pinned).
- Guardrails inherited from Opsie Daisy where they apply (no defaults, no secrets in argv or logs, 14-day dependency quarantine).
