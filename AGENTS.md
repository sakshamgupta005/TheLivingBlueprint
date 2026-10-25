# Agent Guidelines — The Living Blueprint

1. **One Task at a Time**: Work strictly on the assigned task/milestone. Do not jump ahead into subsequent roadmap phases without an explicit prompt.
2. **Preserve Existing Code**: Do not delete, overwrite, or refactor unrelated files or components without justification.
3. **No Fabricated Verification**: Never claim a repository was scanned, a test passed, a build succeeded, or an AI responded unless it has actually executed and returned that result.
4. **Secrets and Privacy**: Never commit API keys, tokens, or credentials to source control. Check only whether required environment configuration exists without printing or logging values.
5. **Honest Reporting**: In every task completion report, provide a single compact `change-reporter` summary (2–4 bullets, files touched, verified commands/tests with real counts, and skipped/risks). Never output lengthy prose or unprompted breakdowns.

## Part 2.5 Non-Negotiable: Preserve the Existing Living Blueprint Theme

Before implementing the Part 2.5 frontend, inspect the existing application and identify its actual design tokens, CSS variables, typography, component styles, spacing, backgrounds, borders, room visuals, and interaction patterns.

Extend the existing design system. Do not redesign it.

1. Preserve the established dark, coffee-toned coder aesthetic and existing branding.
2. Reuse existing CSS variables, shared components, and styling conventions. Do not hard-code replacement colours or introduce a second design system.
3. Keep the house and room representations visually consistent with Blueprint mode. Existing green, amber, and red build-status indicators must retain their original meanings.
4. Represent operational failure risk as a separate, restrained visual layer. Any glow, outline, or animation must fit the existing theme and include readable text or numeric context.
5. Reuse existing buttons, cards, typography, borders, and chart conventions wherever practical.
6. Preserve Barkley, Cleo, existing workflows, chat, and other established features.
7. Add the Resilience mode as a natural extension of the existing application, not as a visually unrelated observability product.
8. Do not change global theme tokens merely to accommodate the new dashboard. If a new token is genuinely necessary, extend the existing token system consistently.
9. Check contrast, keyboard accessibility, responsiveness, and reduced-motion behavior.
10. Compare the finished interface against the original application. Reject changes that make the new mode feel like a different product.

Goal: Users must recognize Living Blueprint immediately while discovering a substantially more capable room-investigation experience.
