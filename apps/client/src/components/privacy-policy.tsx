import type { ReactNode } from "react";

import type { PrivacyPolicyInfo } from "@/lib/legal";

/**
 * Политика конфиденциальности приложения Lady Stretch — единственный
 * юридический документ приложения (решение владельца 2026-10-13: открывается
 * из профиля вместо «Правовых документов», позже — галочка согласия при
 * входе). Текст — только по-английски, на любом языке интерфейса (так решил
 * владелец). Основа — прежняя политика Mobifitness, переписанная под Грузию
 * (Закон Грузии «О защите персональных данных» 2023 г.) и под то, что
 * приложение реально собирает: анкета (в том числе здоровье), вес, записи,
 * абонементы, оценки тренеров. Услуги студии регулирует публичная оферта на
 * сайте — здесь только персональные данные.
 *
 * Компонент без хуков и запросов: реквизиты — props (lib/legal.ts), так его
 * можно отрендерить и вне приложения. Меняете, что собирает приложение, —
 * поправьте разделы 4–8.
 */
export function PrivacyPolicy({ info }: { info: PrivacyPolicyInfo }) {
  const brand = info.brand;
  // Почта и телефоны — простым текстом, не ссылками (решение владельца 2026-10-14).
  const email = info.email;

  return (
    <article className="privacy-policy space-y-6 text-[15px] leading-relaxed text-foreground [&_a[x-apple-data-detectors]]:pointer-events-none [&_a[x-apple-data-detectors]]:text-[inherit] [&_a[x-apple-data-detectors]]:no-underline [&_h2]:text-lg [&_h2]:font-semibold [&_h2]:leading-snug [&_li]:pl-1 [&_ol]:list-[lower-alpha] [&_ol]:space-y-1.5 [&_ol]:pl-5 [&_p]:mt-2 [&_ul]:list-disc [&_ul]:space-y-1.5 [&_ul]:pl-5 [&_ul]:mt-2 [&_ol]:mt-2">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold leading-tight">Privacy Policy</h1>
        <p className="text-sm text-muted-foreground">
          Personal Data Confidentiality Policy of the {brand} mobile application · Effective from{" "}
          {formatDate(info.effectiveDate)}
        </p>
      </header>

      <Section n={1} title="General provisions">
        <p>
          1.1. This Privacy Policy (the “Policy”) explains how the personal data of clients of the{" "}
          {brand} studios in Tbilisi who use the {brand} mobile application (the “App”) is
          collected, used, stored, protected and shared by:
        </p>
        <ul>
          {info.operators.map((o) => (
            <li key={o.idCode}>
              {o.name}, registered by the National Agency of Public Registry of Georgia,
              identification number {o.idCode} — in respect of clients of the {brand} {o.studio}{" "}
              studio;
            </li>
          ))}
        </ul>
        <p>
          (each — the “Operator” in respect of the clients of their studio; together — the
          “Operators”, “we”, “us”).
        </p>
        <p>
          1.2. The Operator for your personal data is the entrepreneur with whom you have concluded
          the public offer, that is, the operator of the studio where you buy your memberships. The
          Operators use a common App, database and studio management system and act as joint
          controllers in respect of them: each Operator is responsible for the data of the clients
          of their studio, and both are jointly responsible for the security of the common systems.
          You may exercise your rights under this Policy against either Operator using the contact
          details in Section 16.
        </p>
        <p>
          1.3. The Policy is drawn up in accordance with the Law of Georgia “On Personal Data
          Protection” (the “Law”) and other applicable legislation of Georgia, and aims to protect
          the rights and freedoms of individuals, including the right to privacy.
        </p>
        <p>
          1.4. The Policy applies to all personal data that we process through the App and in
          connection with it, including the data that studio staff enter into our studio management
          system when you buy a membership or attend a class.
        </p>
        <p>
          1.5. Studio services (memberships, classes, rules of attendance, payments and refunds) are
          governed by the Public Agreement on the Provision of Physical Fitness and Recreational
          Services of the respective studio (the “public offer”), which you accept when you purchase
          a membership. This Policy is the Personal Data Confidentiality Policy referred to in the
          public offer and governs only the processing of personal data. If the public offer and
          this Policy differ on a personal data matter, this Policy prevails.
        </p>
        <p>
          1.6. The App is available only to clients of {brand} studios: you can sign in only with
          the e-mail address that the studio has recorded in your client card. There is no public
          registration in the App.
        </p>
        <p>
          1.7. By ticking the checkbox when signing in to the App, you confirm that you have read
          this Policy and give your consent to the processing of your personal data as described in
          it. Your consent to the processing of health data (Section 6) is given separately, when
          you choose to answer the health questions in the App questionnaire.
        </p>
        <p>
          1.8. This Policy is always available in the App (Profile → Privacy Policy) and can also be
          requested at the studio reception.
        </p>
      </Section>

      <Section n={2} title="Terms used in this Policy">
        <ul>
          <li>
            <b>Personal data</b> — any information relating to an identified or identifiable natural
            person.
          </li>
          <li>
            <b>Special category data</b> — data relating to a person’s health and other categories
            listed in the Law; in the App, these are the optional health answers of the
            questionnaire.
          </li>
          <li>
            <b>Data subject</b> or <b>you</b> — a client of a {brand} studio who uses the App.
          </li>
          <li>
            <b>Processing</b> — any operation performed on personal data, with or without automated
            means: collection, recording, organisation, storage, adaptation, retrieval, use,
            disclosure, restriction, erasure or destruction.
          </li>
          <li>
            <b>Processor</b> — a person or company that processes personal data on our behalf and
            under our instructions (for example, a hosting provider).
          </li>
          <li>
            <b>Cross-border transfer</b> — transfer of personal data to a person or company located
            outside Georgia.
          </li>
        </ul>
      </Section>

      <Section n={3} title="Principles of processing">
        <p>3.1. We process personal data in accordance with the following principles:</p>
        <ul>
          <li>lawfully, fairly and transparently;</li>
          <li>only for specific, explicit and legitimate purposes set out in this Policy;</li>
          <li>only to the extent necessary for those purposes (data minimisation);</li>
          <li>keeping the data accurate and, where necessary, up to date;</li>
          <li>
            storing the data in a form that identifies you no longer than the purposes require;
          </li>
          <li>ensuring appropriate security and confidentiality of the data.</li>
        </ul>
        <p>
          3.2. We do not verify the accuracy of the personal data you provide. You are responsible
          for providing accurate data and for updating it when it changes — you can do this in the
          App (Profile → Edit profile) or by contacting the studio.
        </p>
      </Section>

      <Section n={4} title="What personal data we process">
        <p>4.1. Identification and contact data:</p>
        <ul>
          <li>first and last name;</li>
          <li>e-mail address (it is also your sign-in login);</li>
          <li>phone number(s);</li>
          <li>date of birth and gender;</li>
          <li>profile photo, if you upload one.</li>
        </ul>
        <p>
          4.2. Questionnaire data, which you provide when you first sign in and can update later:
        </p>
        <ul>
          <li>
            training experience, current activity level, goals, desired training frequency and
            preferred training times;
          </li>
          <li>height, weight and the history of your weight measurements;</li>
          <li>how you heard about us.</li>
        </ul>
        <p>
          4.3. Health data (special category data, optional): the health conditions you choose to
          mark in the questionnaire (for example, back or joint problems, cardiovascular conditions
          or blood pressure, a recent injury, pregnancy, chronic conditions) and any comments you
          add. See Section 6.
        </p>
        <p>4.4. Membership and payment data:</p>
        <ul>
          <li>
            memberships and other services purchased, their prices, discounts, terms, freezes and
            the number of remaining sessions;
          </li>
          <li>
            payment amounts, dates, methods and schedules (instalments), refunds, and the staff
            member who made the sale.
          </li>
        </ul>
        <p>
          We do not collect or store bank card details. If online payment becomes available in the
          App, card payments will be processed by a bank or a licensed payment provider, and we will
          receive only the payment confirmation.
        </p>
        <p>4.5. Bookings and activity data:</p>
        <ul>
          <li>
            class bookings and cancellations (including the cancellation reason), attendance and
            missed classes;
          </li>
          <li>
            your visit history and statistics shown in the App (for example, the number of visits
            and estimated calories burned, calculated from your weight and attended classes);
          </li>
          <li>
            the ratings you give to trainers (only the average rating of a trainer is shown to other
            users, without your name);
          </li>
          <li>
            the feedback you send through the feedback form (studio, topic, message, mood and, if
            you choose to provide them, your name and phone number or Instagram account) — it is
            available only to studio staff who handle feedback;
          </li>
          <li>
            your answers to satisfaction surveys in the App (a score from 0 to 10 and your comment)
            and whether you have answered or closed a survey. Answering is voluntary.
          </li>
        </ul>
        <p>4.6. Technical data:</p>
        <ul>
          <li>
            your account identifier, sign-in session data and the one-time sign-in codes sent to
            your e-mail;
          </li>
          <li>IP address, device and browser type, date and time of requests (in server logs);</li>
          <li>
            how you use the App: the devices on which you use it (device type and model, operating
            system, browser and their versions, screen size, interface theme, device language and
            time zone), the App version, whether the App is installed on the home screen and whether
            notifications are allowed on the device, when you open the App and which of its sections
            you view;
          </li>
          <li>
            if you turn on notifications — the push subscription of your device (a technical address
            and encryption keys issued by your phone’s notification service) and the App language on
            that device;
          </li>
          <li>your language setting and data stored on your device (see Section 12).</li>
        </ul>
        <p>
          4.7. We do not use advertising trackers or third-party analytics in the App (the App usage
          data in clause 4.6 is collected by the App itself and stored only in our database) and do
          not process biometric data.
        </p>
      </Section>

      <Section n={5} title="Purposes and legal grounds of processing">
        <p>5.1. We process personal data for the following purposes:</p>
        <ol>
          <li>
            <b>Your account and sign-in</b> — creating and maintaining your App account and sending
            one-time sign-in codes. Grounds: performance of the contract with you (the public offer)
            and your consent.
          </li>
          <li>
            <b>Studio services</b> — showing the schedule, booking and cancelling classes, recording
            attendance, managing your memberships, payments and remaining sessions. Grounds:
            performance of the contract.
          </li>
          <li>
            <b>Safe and personalised training</b> — allowing trainers to take your experience, goals
            and health into account and adjust the load. Grounds: your consent (for health data —
            your explicit written consent, see Section 6).
          </li>
          <li>
            <b>Your progress in the App</b> — visit history, weight history and activity statistics.
            Grounds: performance of the contract and your consent.
          </li>
          <li>
            <b>Service messages</b> — sign-in codes, notices about bookings, cancelled or changed
            classes and your memberships, in the App (including push notifications, if you have
            turned them on), by e-mail, by phone or SMS. Grounds: performance of the contract.
          </li>
          <li>
            <b>Studio news and offers</b> — news and offers in the App (including push
            notifications, if you have turned them on; you can turn them off at any time in your
            phone settings) and, only if you have agreed to it, by e-mail or messengers. You can opt
            out at any time. Grounds: your consent.
          </li>
          <li>
            <b>Photos and videos at the studio</b> — publishing photos and videos taken at the
            studio in which you appear on our social media and website, on the basis of the consent
            given in the public offer. You may withdraw this consent at any time by contacting us;
            we will then stop using such materials and remove them where possible. Grounds: your
            consent.
          </li>
          <li>
            <b>Accounting, tax and other legal obligations</b> — keeping records of sales, payments
            and refunds. Grounds: compliance with the legislation of Georgia.
          </li>
          <li>
            <b>Security and service quality</b> — protecting the App and accounts from unauthorised
            access, resolving errors and helping you with the App (for this, the staff of your
            studio see your devices, the App version, whether notifications are turned on and when
            you last used the App), asking for your feedback in satisfaction surveys, analysing how
            the App is used and preparing anonymised statistics to improve the App and our services.
            Grounds: our legitimate interest.
          </li>
        </ol>
        <p>
          5.2. We do not use your personal data for purposes incompatible with those listed above
          and do not make decisions about you based solely on automated processing.
        </p>
      </Section>

      <Section n={6} title="Health data">
        <p>
          6.1. Answering the health questions is voluntary. We process health data only on the basis
          of your explicit written consent, which you give electronically by marking the relevant
          answers in the App questionnaire after reading this Policy.
        </p>
        <p>
          6.2. Health data is used only so that trainers and studio administrators can take your
          condition into account when planning your training. It is available only to the staff of
          the studio where you are a client and is not shared with third parties, except where
          required by law.
        </p>
        <p>
          6.3. If you do not give this consent, you can still use the App and attend classes; in
          that case, please inform your trainer in person about any conditions that may affect your
          training. You may withdraw your consent at any time by contacting us (Section 11); we will
          then delete your health answers.
        </p>
        <p>
          6.4. The information in the App and the trainer’s recommendations are not medical advice
          and do not replace a consultation with a doctor.
        </p>
      </Section>

      <Section n={7} title="Who has access to your data and to whom we transfer it">
        <p>
          7.1. Studio staff — trainers, administrators and managers of the {brand} studio where you
          are a client — have access to your data to the extent needed for their duties. Access is
          granted through personal staff accounts with role-based permissions.
        </p>
        <p>
          7.2. If you also train in the other {brand} studio, the staff and the Operator of that
          studio may access the data needed to serve you there.
        </p>
        <p>
          7.3. We use the following processors, bound by contractual confidentiality and data
          protection obligations:
        </p>
        <ul>
          <li>
            Hetzner Online GmbH (Germany) — hosting of the App and its database on servers located
            in the European Union;
          </li>
          <li>
            Resend, Inc. (USA) — delivery of e-mails (sign-in codes and service messages); it
            receives only your e-mail address and the content of the e-mail;
          </li>
          <li>
            Apple Inc. (USA) and Google LLC (USA) — delivery of push notifications to your device
            through their notification services, if you have turned notifications on; the content of
            a notification is encrypted for your device, and they receive only its technical
            address;
          </li>
          <li>
            banks and payment providers — if you pay online, only the data needed to process the
            payment.
          </li>
        </ul>
        <p>
          7.4. We disclose personal data to state authorities (courts, law enforcement, tax
          authorities and others) only in the cases and in the manner established by the legislation
          of Georgia.
        </p>
        <p>
          7.5. We do not sell your personal data and do not transfer it to third parties for their
          own marketing.
        </p>
      </Section>

      <Section n={8} title="Cross-border transfer">
        <p>
          8.1. The App’s servers are located in the European Union, which provides an adequate level
          of personal data protection. E-mail delivery involves a transfer of your e-mail address to
          the United States (Resend, Inc.). If you turn on notifications, they are delivered through
          the notification services of Apple Inc. or Google LLC (USA).
        </p>
        <p>
          8.2. We carry out cross-border transfers only on the grounds provided by the Law —
          including appropriate contractual safeguards with the recipient and your consent given by
          accepting this Policy — and only to the extent necessary for the purposes described in it.
        </p>
      </Section>

      <Section n={9} title="Retention periods">
        <p>9.1. We store personal data for the following periods:</p>
        <ul>
          <li>
            Account, profile, questionnaire, weight history, bookings and trainer ratings — for as
            long as you are a client of the studio and have an App account. When your client card is
            deleted, or at your request, your App account and this data are deleted.
          </li>
          <li>
            Records of sales, payments and refunds — for the period required by the tax and
            accounting legislation of Georgia, even after your account is deleted.
          </li>
          <li>
            Push subscription of your device — until you sign out of the App on that device; it is
            also deleted when notifications are turned off or the App is removed (the notification
            service informs us about it).
          </li>
          <li>
            Satisfaction survey answers — for as long as they are needed for service quality
            statistics; when your client card is deleted, they are kept without your name and
            without a link to your account.
          </li>
          <li>
            Information about your devices and how you use the App — for as long as you have an App
            account (we keep only the 10 most recently used devices); the day-by-day record of App
            usage — for 400 days.
          </li>
          <li>Server logs — for a limited period needed to ensure security.</li>
          <li>
            Anonymised statistical data, which no longer identifies you, may be stored without time
            limit.
          </li>
        </ul>
        <p>
          9.2. Processing also stops if you withdraw your consent (where consent is the only ground
          for it), if the purpose of processing is achieved, or if unlawful processing is
          identified. Data subject to deletion is erased from our systems, including from the
          backups within their regular rotation cycle.
        </p>
      </Section>

      <Section n={10} title="Your rights">
        <p>10.1. In accordance with the Law, you have the right to:</p>
        <ul>
          <li>
            receive information on whether and how we process your personal data, for what purposes
            and on what grounds, to whom it is disclosed and for how long it is stored;
          </li>
          <li>access your personal data and obtain a copy of it;</li>
          <li>request the correction of inaccurate or incomplete data;</li>
          <li>
            request the deletion or destruction of your data, or the restriction (blocking) of its
            processing, where the grounds established by the Law apply;
          </li>
          <li>
            receive the data you provided in a structured, commonly used format (data portability),
            where the Law provides for it;
          </li>
          <li>object to the processing of your data for direct marketing at any time;</li>
          <li>
            withdraw your consent at any time — this does not affect the lawfulness of processing
            carried out before the withdrawal;
          </li>
          <li>
            file a complaint with the Personal Data Protection Service of Georgia or with a court.
          </li>
        </ul>
        <p>
          10.2. You can correct your name, phone number and profile photo yourself in the App
          (Profile → Edit profile).
        </p>
        <p>
          10.3. Please note that without the data necessary to identify you and record your bookings
          and memberships, we will not be able to provide you with access to the App.
        </p>
      </Section>

      <Section n={11} title="How to exercise your rights">
        <p>
          11.1. Send your request to {email}, preferably from the e-mail address linked to your App
          account, or submit it at the studio reception. We may ask you to confirm your identity
          before fulfilling the request.
        </p>
        <p>
          11.2. We respond free of charge, without undue delay and within the time limits
          established by the Law. If we cannot fulfil your request, we will explain the reasons.
        </p>
        <p>
          11.3. Your access to data may be restricted where the Law provides for it, including when
          it would affect the rights and legitimate interests of other persons.
        </p>
      </Section>

      <Section n={12} title="Cookies and data stored on your device">
        <p>12.1. The App stores on your device only what it needs to work:</p>
        <ul>
          <li>a cookie with your chosen interface language;</li>
          <li>your sign-in session, so that you do not have to enter a code each time;</li>
          <li>
            a copy of recently loaded screens, so that the App opens faster — it is deleted when you
            sign out;
          </li>
          <li>
            a random identifier of the App installation, so that we can tell your devices apart, and
            the list of App sections you have opened until it is sent to us (see clause 4.6).
          </li>
        </ul>
        <p>
          12.2. We do not use advertising or tracking cookies. Links in the App to third-party
          services (Instagram, WhatsApp, maps, tip payment pages and others) lead to resources that
          are subject to their own privacy policies; we are not responsible for them.
        </p>
      </Section>

      <Section n={13} title="How we protect your data">
        <p>
          13.1. We take legal, organisational and technical measures to protect personal data
          against unauthorised or accidental access, destruction, alteration, blocking, copying,
          disclosure and other unlawful actions, including:
        </p>
        <ul>
          <li>encrypted (HTTPS) connections between the App and our servers;</li>
          <li>sign-in by one-time codes sent to your e-mail, without passwords;</li>
          <li>
            access rules enforced at the database level: each client sees only their own data, and
            staff see only the data of their studio within their role;
          </li>
          <li>personal accounts for staff, granted and revoked by the studio owner;</li>
          <li>confidentiality obligations of staff and processors;</li>
          <li>regular backups and monitoring of the systems.</li>
        </ul>
        <p>
          13.2. In the event of a personal data breach, we will take measures to limit its
          consequences and will notify the Personal Data Protection Service of Georgia and you where
          required by the Law.
        </p>
      </Section>

      <Section n={14} title="Minors">
        <p>
          14.1. Clients under 18 may attend classes only in the presence of their parent or legal
          representative. Personal data of a minor is provided by, and processed with the consent
          of, their parent or legal representative, who also gives the consents described in this
          Policy on the minor’s behalf. We do not knowingly collect personal data of persons under
          18 without such consent.
        </p>
        <p>
          14.2. If you are a parent or legal representative and believe that a minor has provided us
          with personal data without your consent, please contact us at {email}, and we will delete
          it.
        </p>
      </Section>

      <Section n={15} title="Changes to this Policy">
        <p>
          15.1. We may update this Policy, for example when the App gets new features. The current
          version is always available in the App, with the date it takes effect.
        </p>
        <p>
          15.2. We will notify you of material changes in the App or by e-mail in advance and, where
          the Law requires, ask for your consent again.
        </p>
      </Section>

      <Section n={16} title="Operators’ details">
        {info.operators.map((o) => (
          <div key={o.idCode} className="mt-3">
            <p className="font-semibold">
              {brand} {o.studio}
            </p>
            <ul className="!mt-1 !list-none !pl-0 space-y-1">
              <li>{o.name}</li>
              <li>Registered by the National Agency of Public Registry of Georgia</li>
              <li>Identification number: {o.idCode}</li>
              <li>Address: {o.address}</li>
              <li>Phone: {o.phone}</li>
              <li>E-mail: {email}</li>
            </ul>
          </div>
        ))}
      </Section>
    </article>
  );
}

function Section({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <section>
      <h2>
        {n}. {title}
      </h2>
      {children}
    </section>
  );
}

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/** 2026-10-13 → 13 October 2026 (без Intl: текст политики всегда английский). */
function formatDate(iso: string) {
  const [y, m, d] = iso.split("-").map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
}
