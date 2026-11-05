import TablecastApp from "@/components/TablecastApp";
import { demoSummaries } from "@/data/demos";

export default function Home() {
  // With LIVE_RUNS_TOKEN set, live runs need the owner's or the judges' link: the page says so to everyone else.
  return <TablecastApp demos={demoSummaries()} liveLocked={!!process.env.LIVE_RUNS_TOKEN} />;
}
