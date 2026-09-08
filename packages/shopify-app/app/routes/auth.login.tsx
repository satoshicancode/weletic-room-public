import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { Form, useActionData, useLoaderData } from "@remix-run/react";
import { login } from "../shopify.server";

export async function loader({ request }: LoaderFunctionArgs) {
  return json(await login(request));
}

export async function action({ request }: ActionFunctionArgs) {
  return json(await login(request));
}

export default function AuthLogin() {
  const loaderErrors = useLoaderData<typeof loader>();
  const actionErrors = useActionData<typeof action>();
  const shopError = actionErrors?.shop || loaderErrors?.shop;

  return (
    <main style={{ margin: "4rem auto", maxWidth: 480, padding: "0 1rem" }}>
      <h1>Connect Weletic Room</h1>
      <Form method="post">
        <label htmlFor="shop">Shop domain</label>
        <input
          aria-describedby={shopError ? "shop-error" : undefined}
          aria-invalid={shopError ? true : undefined}
          autoComplete="url"
          id="shop"
          name="shop"
          placeholder="your-store.myshopify.com"
          required
          style={{ display: "block", margin: "0.5rem 0 1rem", width: "100%" }}
          type="text"
        />
        {shopError ? (
          <p id="shop-error" role="alert">
            Enter a valid myshopify.com domain.
          </p>
        ) : null}
        <button type="submit">Continue</button>
      </Form>
    </main>
  );
}
