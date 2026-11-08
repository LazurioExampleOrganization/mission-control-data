# Roadmaps

Roadmap YAML files (`RM-XXXX`) of Lazurio Example Organization live here, in
`roadmaps/<year>/`.

Roadmaps follow `schemas/roadmap.schema.json`, generated from the Zod schema
of the Mission Control template
[LazurioTemplates/mission-control](https://github.com/LazurioTemplates/mission-control)
(`app/v3/src/domain/roadmap.ts`, described in `docs/data.md`):

- Roadmap Priority records explain the ranked intent.
- Roadmap Step records route execution and declare whether they are
  executable.
- Done steps need evidence references.

`bun scripts/validate.ts` checks them with Mission Control's own check,
including the rules a JSON Schema cannot express and the rules across records.
