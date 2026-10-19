# CHANGELOG

## 0.1.1

### Patch Changes

- Add an npm `funding` link to `package.json`, so `npm fund` and the npm page show the donate link.

## 0.1.0

### Minor Changes

- 2768a60: First release: Facebook Page, Instagram, Threads and Pinterest image
  publishing behind one `SocialPublisherPort`, with OAuth logins (long-lived
  tokens and refresh), `LoginSession`, an S3 temporary image store (`./s3`)
  and the Node OAuth redirect listener (`./node`). Extracted from
  etsy-dashboard.
