# Product — daisy-example

The synthetic example application for Opsie Daisy. It exists so that every aspect Daisy must handle can be exercised repeatably: several services, a PostgreSQL database with real writes, a persistent volume, configuration and a secret, a private image next to public ones, a public hostname, health and version endpoints, failure switches an operator can flip so Daisy investigates, and a write ledger that makes restore proof meaningful.

The specification is the reviewed design in the opsie-daisy repository: `docs/architecture/example-application.md` (item 0093, 2026-09-09). Stefan's direction (2026-09-09): "Noyouknow was meant as an example. If Daisy can run that, she can run a workload. We should set up some other project as an example instead, perhaps a synthetic one that we create to make it easier to exercise all aspects we want to test."

Decisions about Daisy itself live in the opsie-daisy record; this record holds only what is specific to the example: its repository, images, services, switches and campaign.
