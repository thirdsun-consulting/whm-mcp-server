---
name: whm-troubleshooting
description: Which WHM tools to use, and in what order, to diagnose common hosting problems on a cPanel & WHM server — email not arriving or being rejected, a site showing errors, SSL certificate problems, a locked-out user, a full disk, high load, or a suspected spam source. Use when the user reports a problem rather than asking for a specific change.
---

# Diagnosing problems on a WHM server

Work from the symptom to the cause with the read tools. Report what you found and the evidence; propose a fix, and make it only when asked.

## Start here when the report is vague

`whm_get_server_information`, then `whm_check_service_status` with `problems_only: true`, then `whm_get_disk_usage`. A stopped service or a full partition explains most "everything is broken" reports.

## Email is not arriving or bounces

1. `whm_search_mail_delivery_log` with the sender or recipient: the remote server's reply is usually the answer.
2. Rejected as spam or failing authentication: `whm_validate_mail_dns` for the sending domain (SPF, DKIM, DMARC, reverse DNS).
3. Stuck rather than rejected: `whm_get_mail_queue_summary`, then `whm_list_mail_queue` filtered by sender or recipient.
4. Mailbox full: `whm_list_pop_accounts_with_disk` for the account.
5. Nothing sends at all: `whm_check_service_status` for `exim`, and `whm_validate_exim_config`.

## An account may be sending spam

1. `whm_get_exim_stats` sorted by `sent`; look for an account far above the rest or at its hourly limit.
2. `whm_get_mail_queue_summary` for the top senders and accounts.
3. Propose `whm_manage_outgoing_email` with `hold` (keeps mail queued, reversible) before `suspend`.

## A site shows an error

1. `whm_get_domain_owner`, then `whm_get_account_summary`: is the account suspended or over quota?
2. `whm_get_domain_error_log` for the domain: PHP fatals and permission errors show here.
3. A 403 with no obvious cause: `whm_get_modsec_log` filtered by the domain.
4. Broke after a PHP change: `whm_get_php_vhost_versions` for the domain.
5. Wrong site or not resolving: `whm_get_dns_zone` and `whm_get_domain_info`.

## SSL certificate problems

1. `whm_get_ssl_info` for the domain: expiry, issuer, and whether the certificate covers the name.
2. `whm_get_autossl_problems` for the domain or account: why AutoSSL could not issue.
3. `whm_get_autossl_log` with `types: ["warn", "failure"]` for the last run.
4. Expiring soon across the server: `whm_list_ssl_certs` with `expiring_within_days`.

## A user is locked out

1. `whm_get_failed_logins` with `report: "brutes"`, filtered by the user's IP address.
2. `whm_list_cphulk_records` for the blacklist.
3. The fix is `whm_unblock_ips` for that IP address; propose it, and suggest a whitelist entry only for a fixed office address.

## Disk full or quota reached

1. `whm_get_disk_usage` for partitions.
2. `whm_get_account_disk_usage` sorted by `used` or `percent`.
3. Inside one account: `whm_list_pop_accounts_with_disk` for mail, `whm_list_databases` for databases.

## High load or slowness

1. `whm_get_load_avg` and `whm_check_service_status`.
2. `whm_get_mail_queue_summary`: a mail flood drives load.
3. `whm_get_bandwidth_usage` for an account with unusual traffic.

## Reporting

Lead with the cause in one sentence, then the evidence (the log line, the record, the number), then the proposed fix. If the evidence does not settle it, say what you checked and what is still unknown.
