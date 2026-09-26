# Bundled display calendars

The two JSON calendars cover 2020–2050 and ship offline. Both start disabled.
Enabling the Chinese calendar also enables lunar date labels. Calendar data
does not create schedules, reminders or automation jobs.

- `china.json`: lunar festival dates and Qingming from the Hong Kong
  Observatory's [Gregorian–lunar conversion tables](https://www.hko.gov.hk/en/gts/time/conversion.htm).
  Includes common traditional and fixed Gregorian festivals, not annual Chinese
  holiday leave periods or compensating workdays.
- `us.json`: nationwide federal holidays and Saturday/Friday or Sunday/Monday
  observed dates for a standard Monday–Friday schedule, based on
  [OPM's holiday rules](https://www.opm.gov/policy-data-oversight/pay-leave/federal-holidays/).
  Juneteenth begins in 2021. Regional Inauguration Day, state holidays and
  temporary executive-order closures are not included.

Regenerate explicitly with `node scripts/build-bundled-calendars.mjs` (network
required only for maintenance). Future rules and source data may change; this
is a display calendar, not a payroll or leave entitlement calculation.
