# PDF Previews

The web app shows previews of documents without downloading them, so Nextcloud
has to be able to generate a thumbnail for a PDF. This is how that is set up on
our server. See README.md §1 step 6 for the short version and where this fits
into the rest of the setup; `src/lib/tiles.js` (`PREVIEWABLE_KINDS`) is the
app-side half.

# The Short Version

Nextcloud AIO already does this for us. Tick the **Imaginary** box in the AIO
interface and restart the containers. There is nothing to configure by hand.

Do not follow guides that tell you to enable `OC\Preview\PDF`. That is the old
ImageMagick method, and AIO's ImageMagick policy blocks PDF anyway.

# Why Not To Edit The Config By Hand

The Nextcloud container's entrypoint runs this on *every* start:

```sh
# Imaginary
if [ "$IMAGINARY_ENABLED" = 'yes' ]; then
    occ config:system:set enabledPreviewProviders 0  --value="OC\Preview\Imaginary"
    occ config:system:set enabledPreviewProviders 23 --value="OC\Preview\ImaginaryPDF"
    occ config:system:set preview_imaginary_url --value="http://$IMAGINARY_HOST:9000"
    occ config:system:set preview_imaginary_key --value="$IMAGINARY_SECRET"
fi
```

Two things follow from that:

* `IMAGINARY_ENABLED` comes from the checkbox in the AIO interface, not from
  anything you can set with `occ`. The checkbox is the real switch.
* AIO owns index 0 and index 23 and rewrites them on every restart. If you add
  `ImaginaryPDF` at some other index you get a duplicate entry, and when
  Imaginary is later turned off the cleanup branch only deletes indices 0 and
  20 through 23 — your extra entry survives, pointing at a service that is no
  longer running.

On a fresh install AIO seeds indices 1 to 7 with `Image`, `MarkDown`, `MP3`,
`TXT`, `OpenDocument`, `Movie` and `Krita`. `OC\Preview\PDF` is deliberately
absent from that list.

PDF support is genuinely present in the image — the Imaginary container is
built with `vips-poppler`, and AIO documents Imaginary as covering heic, heif,
illustrator, pdf, svg, tiff and webp.

# Checking The Current State

Run these on the Beelink. Add `sudo` if your user is not in the `docker` group.

```bash
sudo docker ps -a --filter name=nextcloud-aio-imaginary --format '{{.Names}}\t{{.Status}}'
sudo docker exec --user www-data nextcloud-aio-nextcloud php occ config:system:get enabledPreviewProviders
sudo docker exec --user www-data nextcloud-aio-nextcloud php occ config:system:get preview_imaginary_url
```

There are three things you might see:

1. No Imaginary container and no `preview_imaginary_url`. Imaginary is off — go
   turn it on.
2. The container is running and the provider list has both `Imaginary` and
   `ImaginaryPDF`. This is the correct state. If previews still are not
   appearing, the problem is somewhere else.
3. The list has `OC\Preview\PDF` in it, or an `ImaginaryPDF` at an index other
   than 23. Someone edited it by hand — clean it up below.

# Turning It On

Open the AIO interface at `https://ours.trilliumsdo.com:8080`, tick
**Imaginary** under the optional containers, then **Stop containers** followed
by **Start containers**. The entrypoint does the rest on the way back up.

# Cleaning Up Hand Edits

Only needed if the check above turned up case 3.

```bash
# a stray manual entry, e.g. at index 30
sudo docker exec --user www-data nextcloud-aio-nextcloud php occ config:system:delete enabledPreviewProviders 30

# the old ImageMagick PDF provider, using whatever index it actually sits at
sudo docker exec --user www-data nextcloud-aio-nextcloud php occ config:system:delete enabledPreviewProviders <index>
```

Then restart the containers from the AIO interface so the entrypoint re-seeds
the values it owns.

If we ever move off AIO's bundled Imaginary and run our own container, the
provider does have to be set by hand — use index 23 to match the convention:

```bash
sudo docker exec --user www-data nextcloud-aio-nextcloud php occ config:system:set enabledPreviewProviders 23 --value="OC\Preview\ImaginaryPDF"
```

# Verifying

```bash
sudo docker exec --user www-data nextcloud-aio-nextcloud php occ config:system:get enabledPreviewProviders
sudo docker exec --user www-data nextcloud-aio-nextcloud php occ config:system:get preview_imaginary_url
sudo docker logs --tail 30 nextcloud-aio-imaginary
```

The provider list should contain `OC\Preview\Imaginary` and
`OC\Preview\ImaginaryPDF`, and the URL should be
`http://nextcloud-aio-imaginary:9000`.

The config dump only proves the setting is there. The real check is to run
`sudo docker logs -f nextcloud-aio-imaginary` and then open a folder of PDFs
in the Nextcloud web UI — you should see requests arrive as the thumbnails
load, or (for this app specifically) hit `/preview/<fileId>?...` directly and
confirm the app's own log has no `preview response was not an image` warnings
(see `src/nextcloud/previews.js`).

# Generating Previews For Files We Already Have

`preview:generate-all` is not a built-in command. It comes from the Preview
Generator app:

```bash
sudo docker exec --user www-data nextcloud-aio-nextcloud php occ app:install previewgenerator
sudo docker exec --user www-data nextcloud-aio-nextcloud php occ preview:generate-all -vvv
```

Run the first pass inside `screen` or `tmux`. On the N150 it can take hours and
will use the whole CPU while it runs. After that, put `occ preview:pre-generate`
on a cron job so new files get handled incrementally instead of on demand.

# Sources

* [Nextcloud `config.sample.php`](https://github.com/nextcloud/server/blob/master/config/config.sample.php) — `preview_imaginary_url`, `enabledPreviewProviders`
* [AIO Nextcloud container `entrypoint.sh`](https://github.com/nextcloud/all-in-one/blob/main/Containers/nextcloud/entrypoint.sh)
* [AIO Imaginary `Dockerfile`](https://github.com/nextcloud/all-in-one/blob/main/Containers/imaginary/Dockerfile)
* [Preview Generator app](https://github.com/nextcloud/previewgenerator)
