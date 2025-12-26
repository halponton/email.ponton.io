# agents.md — email.ponton.io

This repository owns AWS infrastructure and wiring.

## Hard rules

Agents must never:
- run git or CI/CD commands
- modify IAM
- deploy infrastructure
- introduce new resources without permission

Agents must:
- update README.md after changes
- preserve least privilege
- respect dev/prod separation
