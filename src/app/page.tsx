import TablecastApp from "@/components/TablecastApp";
import { demoSummaries } from "@/data/demos";

export default function Home() {
  return <TablecastApp demos={demoSummaries()} />;
}
