import { getPosition, getTimes } from "suncalc";

const day = 86_400_000;

function eventOnDay(event: Date | null, start: number, end: number): Date | undefined {
  if (!event) return undefined;
  const timestamp = event.getTime();
  return start <= timestamp && timestamp < end ? event : undefined;
}

export function solarDay(
  now: Date,
  latitude: number,
  longitude: number,
): { sunrise?: Date; sunset?: Date; elevation: number } {
  const lat = Math.max(-89.8, Math.min(89.8, latitude));
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime();
  const times = getTimes(new Date((start + end) / 2), lat, longitude);
  let sunrise = eventOnDay(times.sunrise, start, end);
  let sunset = eventOnDay(times.sunset, start, end);

  // SunCalc anchors a solar day, which can straddle the host's calendar day
  // Find each event independently in adjacent solar days, keeping calendar
  // boundaries local so DST and locations across the date line remain correct
  for (let offset = -day; offset <= day && (!sunrise || !sunset); offset += 2 * day) {
    const adjacent = getTimes(
      new Date(times.solarNoon.getTime() + offset),
      lat,
      longitude,
    );
    sunrise ??= eventOnDay(adjacent.sunrise, start, end);
    sunset ??= eventOnDay(adjacent.sunset, start, end);
  }

  return {
    ...(sunrise ? { sunrise } : {}),
    ...(sunset ? { sunset } : {}),
    elevation: getPosition(now, lat, longitude).altitude,
  };
}
