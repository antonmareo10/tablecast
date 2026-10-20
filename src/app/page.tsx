import TastecraftApp from "@/components/TastecraftApp";
import { demoSummaries } from "@/data/demos";

export default function Home() {
  return <TastecraftApp demos={demoSummaries()} />;
}
