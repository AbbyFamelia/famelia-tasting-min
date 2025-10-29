// app/proxy/delete/route.js
import { NextResponse } from "next/server";

export async function OPTIONS() {
  return NextResponse.json({}, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    },
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
        { status: 400 }
      );
    }

    const ADMIN_TOKEN = process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN;
    const STORE_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN || shop;

    if (!ADMIN_TOKEN || !STORE_DOMAIN) {
      return NextResponse.json(
        { ok: false, error: "Server missing Shopify env vars" },
        { status: 500 }
      );
    }

    // 1️⃣ Load the tasting.events metafield
    const apiBase = `https://${STORE_DOMAIN}/admin/api/2024-07`;

    const metaListResp = await fetch(
      `${apiBase}/customers/${customer_id}/metafields.json?namespace=tasting&key=events`,
      { headers: { "X-Shopify-Access-Token": ADMIN_TOKEN } }
    );
    if (!metaListResp.ok) {
      const text = await metaListResp.text();
      return NextResponse.json(
        { ok: false, error: "Shopify metafield fetch failed", detail: text },
        { status: 502 }
      );
    }

    const metaList = await metaListResp.json();
    const metafield = (metaList.metafields && metaList.metafields[0]) || null;

    if (!metafield) {
      return NextResponse.json({ ok: true, empty: true });
    }

    // 2️⃣ Parse JSON value
    let value;
    try {
      value =
        typeof metafield.value === "string"
          ? JSON.parse(metafield.value)
          : metafield.value;
    } catch {
      value = { events: [] };
    }
    if (!value || !Array.isArray(value.events)) value = { events: [] };

    // 3️⃣ Find matching event
    const evIndex = value.events.findIndex(
      (e) =>
        (event_handle && e.handle === event_handle) ||
        (!event_handle && event_name && e.name === event_name)
    );
    if (evIndex === -1) {
      return NextResponse.json({ ok: true, notFound: "event" });
    }

    const ev = value.events[evIndex];
    if (!Array.isArray(ev.wines)) ev.wines = [];

    // 4️⃣ Remove the wine
    const pid = Number(product.product_id || 0) || null;
    const handle = product.handle || null;

    const before = ev.wines.length;
    ev.wines = ev.wines.filter((w) => {
      const wPid = Number(w.product_id || 0) || null;
      const wHandle = w.handle || null;
      const matchByPid = pid && wPid && wPid === pid;
      const matchByHandle = handle && wHandle && wHandle === handle;
      return !(matchByPid || matchByHandle);
    });
    const removedCount = before - ev.wines.length;

    // Optional: remove empty event
    // if (ev.wines.length === 0) value.events.splice(evIndex, 1);

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
        { status: 502 }
      );
    }

    return NextResponse.json({ ok: true, removed: removedCount });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err.message || "Server error" },
      { status: 500 }
    );
  }
}
