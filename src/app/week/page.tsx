import type { Metadata } from "next";
import WeekApp from "@/components/week/WeekApp";
import { demoSummaries } from "@/data/demos";

export const metadata: Metadata = {
  title: "Tablecast Week · plan the week's posts and queue them in Buffer",
  description: "Turn a verified weekly plan for a restaurant into posts with exact times and reasons, review them, and send them to your Buffer queue as drafts. The queue follows the weather.",
};

export default function WeekPage() {
  return <WeekApp demos={demoSummaries()} />;
}
