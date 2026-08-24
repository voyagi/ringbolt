import { type ReactNode, useState } from "react";
import type { ContactView } from "../../domain/view.js";
import { get, post, put, remove } from "../api.js";
import { TextField } from "../parts/fields.js";
import { Nothing, Waiting, Wrong } from "../parts/states.js";
import { Verdict } from "../parts/verdict.js";
import { usePoll } from "../poll.js";
import { useSaving } from "../save.js";

/** The rota every service falls back to when it has none of its own. */
const SHARED = "*";

type Rotation = {
  service: string;
  contacts: ContactView[];
  own: boolean;
  usesConfiguredNumber: boolean;
};

/**
 * Who gets telephoned, in what order, and what happens when nobody answers. The order is the whole
 * point: escalation walks down this list, so the second name is the person who gets woken at four
 * in the morning when the first one sleeps through it.
 */
export function Rota(): ReactNode {
  const people = usePoll<{ contacts: ContactView[] }>(
    () => get("/api/config/contacts"),
    null,
  );
  const order = usePoll<Rotation>(
    () => get(`/api/config/rotation/${encodeURIComponent(SHARED)}`),
    null,
  );

  if (people.status === "loading" || order.status === "loading")
    return <Waiting what="the rota" />;
  if (people.status === "failed")
    return <Wrong error={people.error} again={people.again} />;
  if (order.status === "failed")
    return <Wrong error={order.error} again={order.again} />;

  const refresh = () => {
    people.again();
    order.again();
  };

  return (
    <>
      <header>
        <h1>Rota</h1>
        <p>
          A live build may only ring numbers named in its own deployment
          configuration, so adding somebody here is not enough on its own to
          make their telephone go off.
        </p>
      </header>

      <div className="forms">
        <section className="card">
          <h2>THE CALLING ORDER</h2>
          {order.value.usesConfiguredNumber ? (
            <Nothing heading="Nobody is in the rota">
              Ringbolt rings the number in this deployment&apos;s own
              configuration instead, so a fresh install still reaches somebody.
            </Nothing>
          ) : (
            <Order contacts={order.value.contacts} onChanged={refresh} />
          )}
        </section>

        <section className="card">
          <h2>CONTACTS</h2>
          <People
            contacts={people.value.contacts}
            inRota={order.value.contacts.map((one) => one.id)}
            onChanged={refresh}
          />
        </section>
      </div>
    </>
  );
}

function Order({
  contacts,
  onChanged,
}: {
  contacts: readonly ContactView[];
  onChanged: () => void;
}): ReactNode {
  const saving = useSaving();

  const move = (from: number, by: number) => {
    const to = from + by;
    const ids = contacts.map((one) => one.id);
    const moving = ids[from];
    const displaced = ids[to];
    if (moving === undefined || displaced === undefined) return;
    ids[from] = displaced;
    ids[to] = moving;
    void saving
      .run(() =>
        put(`/api/config/rotation/${encodeURIComponent(SHARED)}`, {
          contactIds: ids,
        }),
      )
      .then((ok) => ok && onChanged());
  };

  return (
    <>
      <ol className="order">
        {contacts.map((contact, index) => (
          <li key={contact.id}>
            <span className="seat mono">{index + 1}</span>
            <span className="who">{contact.name}</span>
            <button
              type="button"
              className="btn quiet"
              disabled={index === 0 || saving.busy}
              aria-label={`Call ${contact.name} earlier`}
              onClick={() => move(index, -1)}
            >
              Earlier
            </button>
            <button
              type="button"
              className="btn quiet"
              disabled={index === contacts.length - 1 || saving.busy}
              aria-label={`Call ${contact.name} later`}
              onClick={() => move(index, 1)}
            >
              Later
            </button>
          </li>
        ))}
      </ol>
      <p className="note">
        Nobody left in the list means the incident is closed rather than left
        holding the alert, and the next repeat rings again.
      </p>
      <Verdict saving={saving} done="Order saved." />
    </>
  );
}

function People({
  contacts,
  inRota,
  onChanged,
}: {
  contacts: readonly ContactView[];
  inRota: readonly string[];
  onChanged: () => void;
}): ReactNode {
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const saving = useSaving();
  const seated = new Set(inRota);

  const add = async (event: React.FormEvent) => {
    event.preventDefault();
    if (await saving.run(() => post("/api/config/contacts", { name, phone }))) {
      setName("");
      setPhone("");
      onChanged();
    }
  };

  const put_ = (id: string) =>
    put(`/api/config/rotation/${encodeURIComponent(SHARED)}`, {
      contactIds: [...inRota, id],
    });

  return (
    <>
      <ul className="order">
        {contacts.map((contact) => (
          <li key={contact.id}>
            <span className="who">
              {contact.name}
              <span className="note mono">{contact.phone}</span>
            </span>
            {seated.has(contact.id) ? (
              <span className="label">IN THE ROTA</span>
            ) : (
              <button
                type="button"
                className="btn quiet"
                disabled={saving.busy}
                onClick={() => {
                  void saving
                    .run(() => put_(contact.id))
                    .then((ok) => ok && onChanged());
                }}
              >
                Add to rota
              </button>
            )}
            <button
              type="button"
              className="btn quiet"
              disabled={saving.busy}
              aria-label={`Delete ${contact.name}`}
              onClick={() => {
                void saving
                  .run(() => remove(`/api/config/contacts/${contact.id}`))
                  .then((ok) => ok && onChanged());
              }}
            >
              Delete
            </button>
          </li>
        ))}
      </ul>

      <form onSubmit={add} style={{ marginTop: "1.25rem" }}>
        <TextField label="NAME" value={name} onChange={setName} />
        <TextField
          label="NUMBER"
          type="tel"
          hint="E.164, so +31612345678 rather than 06 12345678."
          value={phone}
          onChange={setPhone}
        />
        <div className="row">
          <button className="btn primary" type="submit" disabled={saving.busy}>
            Add this person
          </button>
          <Verdict saving={saving} done="Done." />
        </div>
      </form>
    </>
  );
}
