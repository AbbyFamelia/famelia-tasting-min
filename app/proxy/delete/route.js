// app/proxy/delete/route.js
import { NextResponse } from "next/server";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export async function OPTIONS() {
  // Preflight should return a 204 with CORS headers and no body
  return new Response(null, {
    status: 204,
    headers: CORS_HEADERS,
  });
}

export async function POST(req) {
  try {
    const body = await req.json();
    const {
      shop,
      customer_id,
      event_handle,
      event_name,
      product = {},
      action,
    } = body || {};

    if (!shop || !customer_id) {
      return NextResponse.json(
  { ok: false, error: "Missing shop or customer_id" },
  { status: 400, headers: CORS_HEADERS }
);
    }

        // Prefer the env vars you're already using in /proxy/save,
    // but fall back to the old names if they exist.
    const ADMIN_TOKEN =
      process.env.SHOPIFY_ADMIN_TOKEN ||
      process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN ||
      "";

    const STORE_DOMAIN =
      process.env.SHOPIFY_SHOP ||
      process.env.SHOPIFY_STORE_DOMAIN ||
      shop ||
      "";

    if (!ADMIN_TOKEN || !STORE_DOMAIN) {
      return NextResponse.json(
        {
          ok: false,
          error: !ADMIN_TOKEN
            ? "Server missing Shopify admin token"
            : "Server missing Shopify store domain"
        },
        { status: 500, headers: CORS_HEADERS }
      );
    }

    // 1️⃣ Load the tasting.events metafield
    const apiBase = `https://${STORE_DOMAIN}/admin/api/2024-10`;

    const metaListResp = await fetch(
      `${apiBase}/customers/${customer_id}/metafields.json?namespace=tasting&key=events`,
      { headers: { "X-Shopify-Access-Token": ADMIN_TOKEN } }
    );
    if (!metaListResp.ok) {
      const text = await metaListResp.text();
      return NextResponse.json(
  { ok: false, error: "Shopify metafield fetch failed", detail: text },
  { status: 502, headers: CORS_HEADERS }
);
    }

    const metaList = await metaListResp.json();
    const metafield = (metaList.metafields && metaList.metafields[0]) || null;

    if (!metafield) {
  return NextResponse.json(
    { ok: true, empty: true },
    { headers: CORS_HEADERS }
  );
}

        // 2️⃣ Parse JSON value (support both legacy {events:[]} and new {wines:[]})
    let valueRaw;
    try {
      valueRaw =
        typeof metafield.value === "string"
          ? JSON.parse(metafield.value)
          : metafield.value;
    } catch {
      valueRaw = {};
    }
    const value = valueRaw && typeof valueRaw === "object" ? valueRaw : {};

    // Normalise product identifiers once
    const pid = Number(product.product_id || 0) || null;
    const handle = product.handle || null;

    let removedCount = 0;

    if (Array.isArray(value.wines)) {
  // 🔄 New wine-first model: { wines: [ { product_id, handle, ..., events: [] } ] }
  const wines = value.wines;

  // Find the wine we want to REMOVE entirely
  const targetIndex = wines.findIndex((w) => {
    const wPid = Number(w.product_id || 0) || null;
    const wHandle = w.handle || null;
    const matchByPid = pid && wPid && wPid === pid;
    const matchByHandle = handle && wHandle && wHandle === handle;
    return matchByPid || matchByHandle;
  });

  if (targetIndex === -1) {
    // Nothing to delete for this wine
    return NextResponse.json(
      { ok: true, notFound: "wine" },
      { headers: CORS_HEADERS }
    );
  }

  // Remove the wine object from the wines array
  wines.splice(targetIndex, 1);
  removedCount = 1;
}
 
    else if (Array.isArray(value.events)) {
      // 🧩 Legacy event-first model: { events: [ { ..., wines: [] } ] }

      // 3️⃣ Find matching event (use collection_handle or id; handle was never set)
      const evIndex = value.events.findIndex(
        (e) =>
          (event_handle &&
            (e.collection_handle === event_handle || e.id === event_handle)) ||
          (!event_handle && event_name && e.name === event_name)
      );
      if (evIndex === -1) {
  return NextResponse.json(
    { ok: true, notFound: "event" },
    { headers: CORS_HEADERS }
  );
}

      const ev = value.events[evIndex];
      if (!Array.isArray(ev.wines)) ev.wines = [];

      // 4️⃣ Remove the wine from this event’s wines array
      const before = ev.wines.length;
      ev.wines = ev.wines.filter((w) => {
        const wPid = Number(w.product_id || 0) || null;
        const wHandle = w.handle || null;
        const matchByPid = pid && wPid && wPid === pid;
        const matchByHandle = handle && wHandle && wHandle === handle;
        return !(matchByPid || matchByHandle);
      });
      removedCount = before - ev.wines.length;

      // Optional: remove empty event
      // if (ev.wines.length === 0) value.events.splice(evIndex, 1);
    } else {
      // Unknown shape – nothing sensible to do
      return NextResponse.json(
  { ok: false, error: "Unexpected tasting.events metafield shape" },
  { status: 500, headers: CORS_HEADERS }
);
    }

    // 5️⃣ Save updated metafield
    const updateBody = {
      metafield: {
        id: metafield.id,
        value: JSON.stringify(value),
        type: "json",
      },
    };

    const updateResp = await fetch(`${apiBase}/metafields/${metafield.id}.json`, {
      method: "PUT",
      headers: {
        "X-Shopify-Access-Token": ADMIN_TOKEN,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(updateBody),
    });

    if (!updateResp.ok) {
  const text = await updateResp.text();
  return NextResponse.json(
    { ok: false, error: "Shopify metafield update failed", detail: text },
    { status: 502, headers: CORS_HEADERS }
  );
}

    return NextResponse.json(
  { ok: true, removed: removedCount },
  { headers: CORS_HEADERS }
);
  } catch (err) {
  return NextResponse.json(
    { ok: false, error: err.message || "Server error" },
    { status: 500, headers: CORS_HEADERS }
  );
}
}
