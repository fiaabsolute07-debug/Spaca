type Window = { weekday: number; startMinute: number; endMinute: number };

const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const clock = (minute: number) => minute >= 1440 ? '23:59' : `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
const ZONES = ['UTC', 'Asia/Ho_Chi_Minh', 'Asia/Singapore', 'Asia/Tokyo', 'Asia/Seoul', 'Asia/Dubai', 'Asia/Kolkata', 'Europe/London', 'Europe/Berlin', 'Europe/Istanbul', 'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'America/Sao_Paulo', 'Australia/Sydney'];

/**
 * Weekly availability for ACCESS sessions as a plain form (works before or without JavaScript): one window per
 * weekday in the creator's time zone. `set_availability` validates the times; 23:59 means until midnight.
 */
export function AvailabilityEditor({ timeZone, windows }: { timeZone: string | null; windows: Window[] }) {
  const zone = timeZone ?? 'UTC';
  const zones = ZONES.includes(zone) ? ZONES : [zone, ...ZONES];
  const multiple = windows.some((w, i) => windows.findIndex((x) => x.weekday === w.weekday) !== i);
  return <div className="availability-editor">
    <label className="field">
      <span>Time zone</span>
      <select name="time_zone" defaultValue={zone}>
        {zones.map((value) => <option key={value} value={value}>{value}</option>)}
      </select>
    </label>
    {multiple && <p className="notice">Some days have more than one window. Saving here keeps one window per day.</p>}
    <div className="availability-days">
      {WEEKDAYS.map((day, index) => {
        const existing = windows.find((w) => w.weekday === index + 1);
        return <div className="availability-day" key={day}>
          <label className="availability-toggle">
            <input type="checkbox" name={`day_${index + 1}_on`} defaultChecked={Boolean(existing)} /> {day}
          </label>
          <input type="time" step={900} name={`day_${index + 1}_start`} aria-label={`${day} start`} defaultValue={existing ? clock(existing.startMinute) : '09:00'} />
          <span aria-hidden="true">–</span>
          <input type="time" name={`day_${index + 1}_end`} aria-label={`${day} end`} defaultValue={existing ? clock(existing.endMinute) : '17:00'} />
        </div>;
      })}
    </div>
  </div>;
}
