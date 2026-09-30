const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export const seasonEnd = (value: string) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Invalid Date UTC";
  return `${months[date.getUTCMonth()]} ${date.getUTCDate()}, ${String(date.getUTCHours()).padStart(2, "0")}:${String(date.getUTCMinutes()).padStart(2, "0")} UTC`;
};
