import React, { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import {
  ArrowRight,
  Eye,
  EyeOff,
  KeyRound,
  LockKeyhole,
  UserRound,
} from "lucide-react";

const initialConfig = {
  enabled: false,
  inviteRequired: false,
  setupRequired: false,
  mode: "login",
  message: "",
  visible: true,
};

let pushConfig = () => {};

function Brand() {
  return (
    <a className="auth-logo" href="#top" aria-label="OfferFlow">
      <span className="auth-logo-mark" aria-hidden="true">
        <i /><i /><i />
      </span>
      <span>Offer<strong>Flow</strong></span>
    </a>
  );
}

function Field({ children, icon: Icon, id, label }) {
  return (
    <label className="auth-field" htmlFor={id}>
      <span>{label}</span>
      <div className="auth-input-wrap">
        <Icon size={17} strokeWidth={1.8} aria-hidden="true" />
        {children}
      </div>
    </label>
  );
}

function AuthApp() {
  const [config, setConfig] = useState(initialConfig);
  const [mode, setMode] = useState(initialConfig.mode);
  const [passwordVisible, setPasswordVisible] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const usernameRef = useRef(null);
  const formRef = useRef(null);
  const titleId = useId();
  const isRegistering = mode === "register";
  const canRegister = config.enabled || config.setupRequired;
  const showInvite = isRegistering && config.inviteRequired && !config.setupRequired;

  useLayoutEffect(() => {
    pushConfig = (next) => {
      setConfig((current) => ({ ...current, ...next }));
      if (next.mode) setMode(next.mode);
      setError(next.message || "");
    };
    return () => { pushConfig = () => {}; };
  }, []);

  useEffect(() => {
    if (!config.visible) return;
    const timer = window.setTimeout(() => usernameRef.current?.focus(), 320);
    return () => window.clearTimeout(timer);
  }, [config.visible, mode]);

  function selectMode(nextMode) {
    setMode(nextMode);
    setError("");
    setPasswordVisible(false);
    formRef.current?.reset();
  }

  async function submit(event) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const username = String(form.get("username") || "").trim();
    const password = String(form.get("password") || "");
    if (isRegistering && password !== String(form.get("passwordConfirm") || "")) {
      setError("两次输入的密码不一致");
      return;
    }

    setPending(true);
    setError("");
    try {
      const response = await fetch(`/api/auth/${mode}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-OfferFlow-CSRF": "1" },
        body: JSON.stringify({
          username,
          password,
          inviteCode: String(form.get("inviteCode") || "").trim(),
        }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || "暂时无法完成操作");
      formElement.reset();
      window.dispatchEvent(new CustomEvent("offerflow:auth-success", {
        detail: {
          user: result.user,
          passwordChangeEnabled: result.passwordChangeEnabled,
        },
      }));
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setPending(false);
    }
  }

  return (
    <section
      className="auth-screen"
      aria-labelledby={titleId}
      hidden={!config.visible}
    >
      <div className="auth-brand-pane">
        <header className="auth-deck-header">
          <Brand />
          <div className="auth-private"><LockKeyhole size={14} /> 个人工作区</div>
        </header>

        <div className="auth-hero-copy">
          <span className="auth-kicker">求职进度管理</span>
          <h1>把每一次机会<br />稳稳向前推进</h1>
        </div>

        <div className="auth-progress" aria-hidden="true">
          <span className="active"><i />已投递</span>
          <span><i />面试中</span>
          <span><i />Offer</span>
        </div>
      </div>

      <div className="auth-access-zone">
        <main className="auth-console">
          {canRegister && !config.setupRequired ? (
            <div className="auth-mode-switch" role="tablist" aria-label="账号操作">
              <button
                className={mode === "login" ? "active" : ""}
                type="button"
                role="tab"
                aria-selected={mode === "login"}
                onClick={() => selectMode("login")}
              >登录</button>
              <button
                className={mode === "register" ? "active" : ""}
                type="button"
                role="tab"
                aria-selected={mode === "register"}
                onClick={() => selectMode("register")}
              >注册</button>
            </div>
          ) : null}

          <div className="auth-heading">
            <p>{config.setupRequired ? "首次使用" : "欢迎回来"}</p>
            <h2 id={titleId}>
              {isRegistering
                ? (config.setupRequired ? "建立你的工作区" : "创建个人工作区")
                : "登录工作区"}
            </h2>
          </div>

          <form ref={formRef} className="auth-form" onSubmit={submit}>
            <Field id="auth-username" icon={UserRound} label="用户名">
              <input
                id="auth-username"
                ref={usernameRef}
                name="username"
                autoComplete="username"
                minLength={3}
                maxLength={32}
                placeholder="输入账号"
                required
              />
            </Field>
            <Field id="auth-password" icon={KeyRound} label="密码">
              <input
                id="auth-password"
                name="password"
                type={passwordVisible ? "text" : "password"}
                autoComplete={isRegistering ? "new-password" : "current-password"}
                minLength={isRegistering ? 10 : 1}
                maxLength={128}
                placeholder="输入密码"
                required
              />
              <button
                className="password-visibility"
                type="button"
                aria-label={passwordVisible ? "隐藏密码" : "显示密码"}
                title={passwordVisible ? "隐藏密码" : "显示密码"}
                onClick={() => setPasswordVisible((visible) => !visible)}
              >
                {passwordVisible ? <EyeOff size={17} /> : <Eye size={17} />}
              </button>
            </Field>
            {isRegistering && (
              <Field id="auth-password-confirm" icon={LockKeyhole} label="确认密码">
                <input
                  id="auth-password-confirm"
                  name="passwordConfirm"
                  type="password"
                  autoComplete="new-password"
                  minLength={10}
                  maxLength={128}
                  placeholder="再次输入密码"
                  required
                />
              </Field>
            )}
            {showInvite && (
              <Field id="auth-invite-code" icon={KeyRound} label="邀请码">
                <input
                  id="auth-invite-code"
                  name="inviteCode"
                  autoComplete="off"
                  placeholder="输入邀请码"
                  required
                />
              </Field>
            )}
            <p className={`auth-error${error ? " visible" : ""}`} role="alert" aria-live="polite">
              {error || "账号验证信息"}
            </p>
            <button className="auth-submit" type="submit" disabled={pending}>
              <span>{pending ? "正在验证" : (isRegistering ? (config.setupRequired ? "完成设置" : "创建账号") : "进入工作区")}</span>
              <span className="submit-icon">
                {pending ? <i className="auth-spinner" /> : <ArrowRight size={18} strokeWidth={2.2} />}
              </span>
            </button>
          </form>
          <p className="auth-security-note"><LockKeyhole size={13} /> 你的个人数据将安全地保存在独立工作区</p>
        </main>
      </div>
    </section>
  );
}

const rootElement = document.querySelector("#auth-root");
if (!rootElement) throw new Error("OfferFlow auth root is missing");

flushSync(() => createRoot(rootElement).render(<AuthApp />));

window.OfferFlowAuth = {
  show(next = {}) {
    pushConfig({ ...next, visible: true });
  },
  hide() {
    pushConfig({ visible: false, message: "" });
  },
};
