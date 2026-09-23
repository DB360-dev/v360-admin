import { Link } from "react-router-dom";
import { EmptyState } from "@/components/ui/States";

export function NotFound() {
  return (
    <EmptyState title="Page not found" action={<Link to="/" className="link">Go to overview</Link>}>
      The page you're looking for doesn't exist or has moved.
    </EmptyState>
  );
}
