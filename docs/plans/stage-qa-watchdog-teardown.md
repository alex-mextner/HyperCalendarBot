# Stage QA watchdog teardown

## Reliability objective

The root-installed stage runner must preserve its exit code and print exactly one
final result after the watchdog interrupts its client read. Evidence collection,
stage removal, image removal, work directory removal and both lock releases must
still run. This repair belongs to [#894](https://github.com/alex-mextner/HyperCalendarBot/issues/894).

## Implementation and verification

- [x] Reproduce the unchanged watchdog timeout regression on the required server.
- [x] Keep final status selection in the EXIT trap's shell, without command substitution.
- [x] Preserve every original teardown test and assertion; require one complete final result.
- [x] Run all 50 related runtime tests with zero failures and skips.
- [ ] Complete the normal independent review and full-tree test, lint and typecheck gates.
- [ ] Merge through the normal ship path, install from reviewed main, and verify the installed runner.

The related SSH255 classification, deployment exclusion and client-loss criteria
in [#889](https://github.com/alex-mextner/HyperCalendarBot/issues/889) and #894 remain
separate checks of the current trusted driver/browser architecture. This change
does not establish that those broader criteria are complete.
