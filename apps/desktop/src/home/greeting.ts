/** 早上好 / 下午好 / 晚上好 / 夜深了 by the hour. */
export function greetingKey(hour: number): string {
  if (hour < 5) return "home.greeting.night";
  if (hour < 12) return "home.greeting.morning";
  if (hour < 18) return "home.greeting.afternoon";
  return hour < 23 ? "home.greeting.evening" : "home.greeting.night";
}
