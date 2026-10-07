# Included by every location in nginx.conf (add_header in a location replaces inherited ones).
# The app has no inline scripts or styles, so the policy can be strict. If you serve sprites from another
# origin (e.g. a CDN or raw.githubusercontent.com), add it to img-src.
add_header Content-Security-Policy "default-src 'none'; script-src 'self' https://static.cloudflareinsights.com; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self' https://cloudflareinsights.com https://pokepast.es https://vrpaste-backend.vercel.app https://replay.pokemonshowdown.com; manifest-src 'self'; object-src 'none'; base-uri 'self'; form-action 'none'; frame-ancestors 'none'" always;
add_header X-Content-Type-Options "nosniff" always;
add_header Referrer-Policy "no-referrer" always;
add_header Permissions-Policy "camera=(), microphone=(), geolocation=(), payment=()" always;
add_header Cross-Origin-Opener-Policy "same-origin" always;
# Enable only when the site is served over HTTPS:
# add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
