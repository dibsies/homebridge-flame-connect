# Validation: v1.0.1

All 169 tests pass on Node 22.23.3 and Node 24.19.0. Native HAP tests exercise the default drag correction without an experimental configuration switch: early hue/saturation acceptance, 400 ms quiet window, bounded staging, latest-sample replacement during queue/read waits, Off/power/shutdown cancellation, and non-color ordering boundaries. Prepared/sent packets are immutable and never replayed.

The suite also covers existing controls, cloud response compatibility, incomplete/stale state protection, authentication rotation/replacement, characteristic deadlines, remembered colors, anonymous diagnostics and metadata/discovery requirements. A dedicated normal-operation test verifies absent diagnostic command/read contexts, no diagnostic timing measurements and no lighting trace output with Advanced Diagnostics off.

The owner physically confirmed that candidate C resolves the reported drag white flash on an EVO74. This release makes that handling the default while preserving the original RGBW converter and removing the experimental switch. Other models and long/slow gestures still need physical verification. Early HomeKit color-input acceptance indicates queued intent, not guaranteed cloud execution. Ordinary cloud errors remain logged and confirmed displayed state is restored where possible.

Advanced Diagnostics remains opt-in via debugLighting, default false. Existing users who enabled diagnostics should switch it off in settings for normal use. Duplicate legacy lighting traces are removed; detailed packet decoding, trace serialization and diagnostic timing/context collection are skipped in normal operation. No extra cloud calls or telemetry endpoints are added.

This is a prepared local release package, not a claim of GitHub/npm publication. Source archives exclude credentials, installed dependencies, Git history and machine-specific paths. No native macOS helper is included. Existing service identities, custom Home names and pairing remain compatible.
