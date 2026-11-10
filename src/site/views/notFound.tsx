// The 404 for a site path nothing answers, and the page shown when a screen fails. Both render
// without the database: every probe for /wp-login.php lands here.
import { Layout } from "../layout";

export function NotFound() {
  return (
    <Layout title="No such page · Standing" description="Standing has nothing at this address." active={null} stats={null}>
      <section class="result">
        <div class="verdict tone-hold" style="--chars: 9">
          <div class="where">
            <span>
              <b>Standing</b>
            </span>
          </div>
          <div class="status-word">Not found</div>
          <h1 class="who">No such page.</h1>
          <p class="result-line">
            Nothing is at this address. The link may be mistyped, or the record may have expired: a public lookup nobody watches is kept for 24 hours.
          </p>
          <div class="acts">
            <a href="/">Check a register</a>
          </div>
        </div>
      </section>
    </Layout>
  );
}

export function ServerError() {
  return (
    <Layout title="Something went wrong · Standing" description="Standing could not show this page." active={null} stats={null}>
      <section class="result">
        <div class="verdict tone-hold" style="--chars: 9">
          <div class="where">
            <span>
              <b>Standing</b>
            </span>
          </div>
          <div class="status-word">Not shown</div>
          <h1 class="who">This page could not be shown.</h1>
          <p class="result-line">Reading Standing's records failed. Nothing stored is lost. Try again in a minute.</p>
          <div class="acts">
            <a href="/">Check a register</a>
          </div>
        </div>
      </section>
    </Layout>
  );
}
