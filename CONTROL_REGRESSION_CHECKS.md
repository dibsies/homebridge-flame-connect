# v1.0.1 regression coverage

169 tests pass on Node 22 and 24. Coverage includes Fireplace, Flames, two native flame brightness levels, five-step Flame Speed, thermostat target/state, Eco/Fan Only/Boost, Media Bed/Accent/Logs power/color/dimming, and optional effects. Native HAP requests exercise the actual HTTP response parser and real binary encoders using synthetic cloud responses.

Color regressions replay the captured 220/280 ms drag cadence, supersession of an obsolete near-white sample during a blocked overview, light/whole-fireplace Off cancellation, shutdown settlement, heater ordering boundaries, and immutable already-transmitted packets. Intentional white and pastel colors, dimming, remembered Off/On colors and sibling-light preservation remain covered. The experimental opt-in is removed; native HomeKit color gestures use the correction by default.

Diagnostic regressions verify safe selected fields, fixed control packet bytes, anonymous labels, enabled/disabled packet equivalence, and a disabled fast path with no diagnostic contexts or timing measurements. API failures, explicit result-code rejection, timeouts, late-write prevention, safe auth retry, and uncertain-write recovery remain covered. Physical confirmation beyond the owner-tested unit is not inferred from these tests.
