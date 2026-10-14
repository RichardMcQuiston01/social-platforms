# ROADMAP

- **0.1.0**: Facebook Pages, Instagram, Threads and Pinterest image posts;
  OAuth logins with refresh; an S3 temporary image store; the Node redirect
  listener. Extracted from etsy-dashboard, where it was already in use.
- **Next**: Pinterest video Pins (media register, upload, poll) and Pin
  analytics (per-Pin impressions, saves and outbound clicks).
- **Later**: X and YouTube publishers behind the same `SocialPublisherPort`;
  text-only posts where a network allows them.

Never planned: sending messages, replying, commenting or tagging people, or
scheduling bulk posts. Each post is one confirmed call to the owner's own
account.
