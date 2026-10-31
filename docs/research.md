# What people have hit (research notes, Oct 2026)

Collected from X search on 31 Oct 2026. Each line is a pain point and where we saw it.

1. **Agents delete things they were told not to touch.** Replit's agent deleted a production database during a code freeze, then said rollback wouldn't work (it did). https://x.com/LoveneeshDhir/status/2115481963842904174 , https://x.com/sannedhi/status/2115844939674431979
2. **Over-broad tokens.** A token made to manage custom domains could also delete production and its backups; it did, in one call, in 9 seconds. https://x.com/Vericto_dev/status/2116245250406846972 , https://x.com/tessl_io/status/2116221309512261723
3. **Rules in the prompt are requests, not gates.** "A rule the agent reads is a request." Checks must live outside the model. https://x.com/asymmetricmind/status/2116217504058016167 , https://x.com/founderarcstone/status/2115699292811772270 , https://x.com/qatcodz/status/2115514426208235564
4. **The agent's own account of what it did isn't evidence.** Need a log written outside the agent: request, action, result, approval. https://x.com/sannedhi/status/2115844939674431979 , https://x.com/sheppaj/status/2116160125450752324
5. **"Which agent touched which file last?"** Hard once you run more than one agent. https://x.com/arshadbarves/status/2116569678671921645
6. **Keys leak from agent configs, .env files and coding-tool configs.** https://x.com/yanez__ai/status/2116568400512405636 , https://x.com/theagentictradr/status/2116547359710515595 , https://x.com/keithrull/status/2116564183395529114 (stolen AI keys resold)
7. **Env vars give every agent everything you have, with no access log.** https://x.com/dmalmros/status/2116558878997365027
8. **Secrets drift between local and cloud runs.** https://x.com/Mkandeger2/status/2116572326925901958
9. **Want short-lived, per-task, per-agent credentials** instead of standing access. https://x.com/POSTURE_CYBER/status/2116545102848110614 , https://x.com/zachbenson817/status/2116562881676521834 , https://x.com/1clawAI/status/2116545815015514485
10. **Approval prompts get missed or rubber-stamped.** Prompts stuck in a terminal get missed, or people start allowing everything; approval fatigue ("one too many yes taps"). https://x.com/IA_noirLAB/status/2116579403983470935 , https://x.com/Mr_V3NOMMM/status/2116562275708596508
11. **Approval prompt can hide the dangerous part.** A text approval prompt cut off the `rm -rf` at the end of a long command; a cron job naming one MCP server ran with all of them. https://x.com/brunooliveira/status/2114336661047795754
12. **MCP auth is messy.** Agents can't reuse an MCP login already approved; start fresh OAuth. https://x.com/chl708/status/2116516820303630536 ; 31 MCP security advisories in 28 days, 41% "untrusted text becomes a command". https://x.com/karlmehta/status/2116522472459657593
13. **Prompt injection through content the agent reads** (PDFs, emails, web pages) leading to sends/payments. https://x.com/ItsvectorX/status/2116555449407578440 , https://x.com/ayodeji_FG/status/2115539991933706720 , https://x.com/sermakarevich/status/2115801259173151024 ("capability-removing guardrails hold; text-inspecting ones fold")
14. **Agents can edit their own safeguards** (monitor, approval gate, audit policy). https://x.com/atul7107/status/2116551198123692296 ; deleting a failing test to go green https://x.com/VibeKitLab/status/2116199702354112984
15. **Writes outside the intended folder.** Claude Code added blockWritesOutsideWorkingDirectories because agents "tidy up" ~/.zshrc. https://x.com/MrAsifShah/status/2116384079113339267
16. **Personal agents near money/email/calendar: users want every risky action to wait for a yes.** https://x.com/nomlastew/status/2115096469204042094 , https://x.com/AnthonyWidodo_/status/2114654180065587412
17. **Wrong-target deletes.** Agent clearing old files hit Delete on the live product. https://x.com/Dandiggastech/status/2115473687352619338 ; a wipe deleted an AI team's working files https://x.com/BeyondDraft/status/2115828744971546822
18. **Malicious extensions/skills reach files and credentials.** Fake Claude Code extension in Cursor's store for 11 hours. https://x.com/SrinivasValekar/status/2116550533641351501
19. **Confidently wrong agents** (misreported rollback) mean you need ground truth and undo. https://x.com/josesito_cuhhh/status/2115814681395003763
20. **Who controls the agent / proving authorization.** "Instructions are not authority." https://x.com/missionzampool/status/2115434674117845247
