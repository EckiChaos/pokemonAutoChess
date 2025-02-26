import React from "react"
import DiscordButton from "../buttons/discord-button"
import GithubButton from "../buttons/github-button"
import PolicyButton from "../buttons/policy-button"
import { useTranslation } from "react-i18next"

export default function Media() {
  const { t } = useTranslation()
  return (
    <div className="media">
      <DiscordButton />
      <GithubButton />
      <PolicyButton />
      <span>V4.1</span>
      <p>
        {t("made_for_fans")}
        <br />
        {t("non_profit")} / {t("open_source")}
        <br />
        {t("copyright")}
      </p>
    </div>
  )
}
