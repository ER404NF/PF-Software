# Mobile store readiness

Last reviewed: 2026-09-21

This document covers the Phone Farm operator client for iPhone/iPad and Android.
It does not cover the macOS host installer that runs WebDriverAgent or the site
agent. The store app is a client of the Phone Farm hub; it must never contain a
site token, proxy credential, model key, signing secret, or a fixed production
operator account.

## Current verdict

**The mobile client is not ready for App Store or Google Play submission.**

The repository currently contains only:

- `mobile/capacitor.config.json`, with the package identifier
  `com.phonefarm.operator` and a placeholder hub URL;
- one loading page in `mobile/www/index.html`; and
- build notes in `mobile/README.md`.

There is no reproducible mobile dependency manifest and lockfile, Android
project, iOS project, signed AAB, signed iOS archive, privacy manifest, store
metadata, or physical-device store build result. The main web client also lets
a user create an account, but it does not currently provide self-service
account deletion. That is a store blocker on both platforms.

The PWA remains the fastest route for real-device testing. Store distribution
is a separate release track and is not required to test Phone Farm from Safari
or Chrome.

## Distribution decision

Choose this before reserving store records or finalizing identifiers.

| Route | Best fit | Recommendation |
|---|---|---|
| Apple Custom App | Named businesses using Apple Business Manager | Best first production route for customer organizations |
| Apple unlisted app | A limited audience that may use managed or unmanaged devices | Good route when a direct App Store link is preferable |
| Managed Google Play private app | Company-managed Android devices and work profiles | Best first Android production route |
| Public App Store and Google Play | A product offered to the general public | Do this only after the native-value and policy work below |

Apple unlisted apps still go through App Review. Managed Google Play private
apps still require a unique package ID and a valid signed build. Private
distribution narrows discovery; it does not make security, privacy, or product
quality optional.

Official distribution references:

- [Apple unlisted app distribution](https://developer.apple.com/support/unlisted-app-distribution)
- [Apple business distribution choices](https://developer.apple.com/business/)
- [Managed Google Play private apps](https://support.google.com/work/android/answer/9563481?hl=en)

## Ordered work list

### P0 - required before either store can review the app

1. **Choose audience and legal publisher.** Decide public, unlisted/custom, or
   private managed distribution. Use organization accounts for the commercial
   product. Apple and Google organization enrollment require a legal entity,
   verified contact details, a working company website, and normally a D-U-N-S
   number. Reserve or confirm that `com.phonefarm.operator` is owned and usable
   before publishing any build. A bundle/package ID cannot be casually changed
   after release.

   - [Apple Developer Program enrollment](https://developer.apple.com/programs/enroll/)
   - [Google Play organization account information](https://support.google.com/googleplay/android-developer/answer/13628312?hl=en)

2. **Turn the scaffold into reproducible native projects.** Add a pinned
   `mobile/package.json` and lockfile, then generate and commit supported
   Capacitor Android and iOS projects. Set an intentional minimum OS version,
   version/build numbers, icons, launch screens, universal/app links where
   needed, and release configurations. Keep the hub URL configurable per build
   or through an authenticated first-run setup; do not ship the placeholder.

3. **Make the mobile client an app rather than a remote website wrapper.** A
   submitted build needs stable first-run setup, connection-state handling,
   retry and offline states, safe-area and keyboard support, native back
   behavior, secure credential handling, and a mobile settings/account screen.
   Add native value such as secure hub enrollment, biometric re-entry, push
   notifications for assignments/interventions, and share/file-picker flows as
   appropriate. Apple explicitly says an app must provide value beyond a
   repackaged website under Guideline 4.2.

   - [Apple App Review Guidelines, including minimum functionality](https://developer.apple.com/app-store/review/guidelines/)

4. **Add complete account deletion.** Phone Farm exposes in-app account
   creation, so the app needs an easy-to-find in-app action that initiates
   deletion of the account and associated personal data. Google also requires
   a public web URL where a user can request deletion. Define which security or
   audit records must be retained, the lawful retention period, and how the
   username and email are removed or irreversibly de-identified. Account
   suspension is not deletion.

   - [Apple account deletion requirements](https://developer.apple.com/support/offering-account-deletion-in-your-app)
   - [Google Play account deletion requirements](https://support.google.com/googleplay/android-developer/answer/13327111?hl=en)

5. **Publish the legal and support pages.** Host stable HTTPS pages for privacy,
   terms, support/contact, and account deletion. Link them from the signed-in
   app and, where appropriate, from the sign-up screen. The privacy policy must
   describe the real service, not a generic template. At minimum, inventory:

   - name, Gmail address, username, role, team, and device assignments;
   - login sessions, IP/network security information, 2FA and recovery state;
   - audit events, device actions, tasks, schedules, approvals and comments;
   - uploaded/downloaded files and any retained screenshots or recordings;
   - AI prompts, outputs, evidence, provider transfers, and retention;
   - proxy configuration and device network-check information;
   - email delivery and every third-party SDK or processor used by the mobile
     binary or hub.

   Then make the Apple App Privacy answers and Google Data safety form match
   the app, backend, providers, and SDKs.

   - [Apple App Privacy details](https://developer.apple.com/help/app-store-connect/manage-app-information/manage-app-privacy)
   - [Google Play Data safety](https://support.google.com/googleplay/android-developer/answer/10787469?hl=en)

6. **Prepare a reviewable demo environment.** Operate a public HTTPS demo hub
   throughout review. Give each store a dedicated reviewer account, working 2FA
   instructions or a fully featured demo mode, and at least one simulated or
   dedicated test device whose screen and controls work. Explain every role and
   non-obvious feature in review notes. Reviewers must not need the private Mac
   mini, a production customer's credentials, or verbal help from the team.

   - [Apple review preparation](https://developer.apple.com/app-store/review/)
   - [Google Play review preparation](https://support.google.com/googleplay/android-developer/answer/9859455?hl=en)

7. **Resolve the remote-control policy position.** Document that the operator is
   authenticated, can open only explicitly assigned devices, the device owner
   authorized the Mac/site enrollment, every action is auditable, and emergency
   stop/revocation are available. The submitted mobile binary should only send
   commands to the Phone Farm hub; it must not use private APIs, root/jailbreak,
   Android `AccessibilityService`, device-admin tricks, or downloaded executable
   code.

   Apple Guideline 4.2.7 is a material review risk because it discusses remote
   desktop clients in terms of user-owned PCs/game consoles and local LAN use,
   while Phone Farm controls managed phones over the internet. This does not
   prove rejection, but public approval cannot be promised from code review
   alone. Describe the enterprise fleet-management use case plainly, provide a
   complete demo, and start with Custom App or unlisted review if that matches
   the audience. Google prohibits unauthorized device/network interference; the
   ownership and consent model must be visible to reviewers.

   - [Apple App Review Guideline 4.2.7](https://developer.apple.com/app-store/review/guidelines/#minimum-functionality)
   - [Google Play device and network abuse policy](https://support.google.com/googleplay/android-developer/answer/16273414?hl=en)
   - [Google Play AccessibilityService policy](https://support.google.com/googleplay/android-developer/answer/10964491?hl=en)

### P1 - platform release work

8. **Build the Android release correctly.** The release submitted after
   2026-08-31 must target Android 16 / API level 36 or higher. Produce a signed
   Android App Bundle, enroll in Play App Signing, use the smallest permission
   set, and verify every merged-manifest permission from Capacitor and its
   plugins. Test 16 KB page-size compatibility, especially if any plugin brings
   native code; Google has announced enforcement for updates from 2027-02-01.

   - [Google Play target API requirements](https://support.google.com/googleplay/android-developer/answer/11926878?hl=en)
   - [Android App Bundles and Play App Signing](https://developer.android.com/guide/app-bundle)
   - [Android 16 KB page-size support](https://developer.android.com/guide/practices/page-sizes)

9. **Complete Google Play declarations and listing.** Provide the app name,
   descriptions, category/tags, contact details, app icon, feature graphic,
   phone/tablet screenshots, privacy URL, ads declaration, app-access
   instructions, target audience, content rating, Data safety answers, and any
   permission or AI declarations. Mark the product as not designed for children
   unless the business intentionally accepts the Families requirements.

   If the mobile app directly lets users generate AI text or other content,
   Google requires in-app reporting/flagging of offensive AI output. Phone
   Farm's existing approval and safety controls help, but they do not replace a
   user-facing report channel when that policy applies.

   - [Google Play app setup](https://support.google.com/googleplay/android-developer/answer/9859454?hl=en)
   - [Google Play preview assets](https://support.google.com/googleplay/android-developer/answer/9866151?hl=en)
   - [Google Play AI-generated content policy](https://support.google.com/googleplay/android-developer/answer/13985936?hl=en)

10. **Pass Google testing gates.** Run internal and closed tests on real phones
    and tablets, inspect the pre-launch report, and fix crashes, ANRs, layout,
    login, stream reconnection, background/foreground, and slow-network faults.
    A personal developer account created after 2023-11-13 must keep at least 12
    testers opted into a closed test continuously for 14 days before applying
    for production access. This special gate does not apply in the same way to
    an organization account, but real testing is still required for release.

    - [Google Play testing requirement for new personal accounts](https://support.google.com/googleplay/android-developer/answer/14151465?hl=en)
    - [Android vitals thresholds](https://support.google.com/googleplay/android-developer/answer/9844486?hl=en)

11. **Build the iOS release correctly.** Build on a Mac with a current paid
    Apple Developer Program team. As of 2026-04-28, uploads must use Xcode 26 or
    later and the iOS 26 SDK or later. Configure the App ID, signing,
    entitlements, deployment target, app icon, launch screen, version/build,
    supported orientations, and an accurate `PrivacyInfo.xcprivacy`. Generate
    Xcode's privacy report and declare every required-reason API used by the app
    or SDKs. Complete encryption export questions; ordinary system HTTPS is
    commonly exempt from documentation, but the declaration is still required.

    - [Apple upcoming submission requirements](https://developer.apple.com/news/upcoming-requirements/)
    - [Apple privacy manifests](https://developer.apple.com/documentation/BundleResources/privacy-manifest-files)
    - [Apple encryption export compliance](https://developer.apple.com/documentation/security/complying-with-encryption-export-regulations)

12. **Complete App Store Connect metadata and compliance.** Add the app record,
    name, subtitle, description, keywords, categories, age-rating questionnaire,
    copyright, support URL, privacy URL, screenshots, review contact and notes,
    availability, and release method. Complete the new age-rating questions and
    accurately publish accessibility labels. If distributed in the EU, declare
    trader status and verify the public contact details required by the Digital
    Services Act.

    - [Required App Store Connect properties](https://developer.apple.com/help/app-store-connect/reference/app-information/required-localizable-and-editable-properties)
    - [Apple screenshot requirements](https://developer.apple.com/help/app-store-connect/manage-app-information/upload-app-previews-and-screenshots)
    - [Apple EU DSA trader requirements](https://developer.apple.com/help/app-store-connect/manage-compliance-information/manage-european-union-digital-services-act-trader-requirements)
    - [Apple accessibility labels](https://developer.apple.com/help/app-store-connect/manage-app-accessibility/manage-accessibility-nutrition-labels)

13. **Pass TestFlight and physical acceptance.** Test at least one current and
    one older supported iPhone/iPad on Wi-Fi and cellular. Exercise first launch,
    sign-up, 2FA, recovery, deletion, every role, device assignment, rotation,
    background/foreground recovery, stream loss, server outage, expired session,
    file upload, notifications, slow links, and emergency stop. Archive the
    exact candidate and distribute it through TestFlight before App Review.

### P2 - commercial and post-release requirements

14. **Choose the payment model before adding any purchase links.** A free client
    for previously purchased enterprise service can qualify for Apple's
    enterprise-service or free-companion treatment when there is no in-app
    purchase or purchase call to action. Consumer digital access may require
    Apple In-App Purchase and Google Play Billing or enrollment in a currently
    allowed regional alternative-billing program. Do not add pricing or signup
    links until the model and target countries are decided.

    - [Apple App Review Guideline 3.1](https://developer.apple.com/app-store/review/guidelines/#business)
    - [Google Play payments policy](https://support.google.com/googleplay/android-developer/answer/9858738?hl=en)

15. **Operate the released app.** Keep store contacts and policies current,
    rotate reviewer credentials after review, monitor crash/ANR and backend
    health, answer deletion requests, maintain dependency and SDK disclosures,
    renew Apple membership/certificates, protect signing and upload keys, and
    test store updates before release.

## Definition of submission-ready

The mobile release is submission-ready only when all of these are true:

- [ ] Distribution route, legal publisher, countries, and payment model are decided.
- [ ] Apple and Google accounts are verified and agreements are current.
- [ ] Final package/bundle identifier and app name are reserved.
- [ ] Reproducible Android and iOS projects are committed with locked dependencies.
- [ ] Production hub selection contains no placeholder and no embedded secret.
- [ ] Privacy, terms, support, and web account-deletion URLs are live.
- [ ] In-app account deletion is implemented and verified end to end.
- [ ] Data inventory, retention schedule, Apple App Privacy, and Play Data safety agree.
- [ ] Reviewer account/demo environment works without private staff intervention.
- [ ] Remote-control ownership, consent, assignment, audit, and revocation are documented.
- [ ] Android signed AAB targets API 36+, passes closed testing and pre-launch checks.
- [ ] iOS archive uses Xcode 26+/iOS 26 SDK+, passes TestFlight on real devices.
- [ ] Store assets, ratings, access instructions, compliance and review notes are complete.
- [ ] The exact submitted builds pass login, live screen/control, outage and deletion tests.

## Next coding milestone

The next locally eligible milestone is **account deletion plus the public privacy,
support and deletion routes**. Before implementing permanent deletion, the owner
must define which audit records are legally or contractually retained and for how
long. After that decision, implement deletion with re-authentication, revoke all
sessions immediately, remove or de-identify personal fields, release device and
assignment ownership, and test that deleted accounts cannot recover or sign in.

