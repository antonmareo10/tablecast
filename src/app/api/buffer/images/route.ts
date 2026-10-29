import { errorResponse, sameOrigin } from "@/lib/buffer/http";
import { PostsSchema } from "@/lib/buffer/schemas";
import { imageSecret, signedImagePath } from "@/lib/post-image";

// Signed image paths for the posts as the owner has them now (a moved post changes its weekday on the picture).
export async function POST(request: Request) {
  if (!sameOrigin(request)) return Response.json({ error: "forbidden" }, { status: 403 });
  try {
    const body = (await request.json().catch(() => null)) as { posts?: unknown } | null;
    const parsed = PostsSchema.safeParse(body?.posts);
    if (!parsed.success) return Response.json({ error: "bad_request" }, { status: 400 });
    let secret: string;
    try {
      secret = imageSecret();
    } catch {
      return Response.json({ images: {} });
    }
    return Response.json({ images: Object.fromEntries(parsed.data.map((p) => [p.id, signedImagePath(p.image, secret)])) });
  } catch (err) {
    return errorResponse(err);
  }
}
