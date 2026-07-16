import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import {
  buildJsfPostback,
  JsfFormParseError,
  JsfPartialResponseParseError,
  JsfPostbackBuildError,
  JsfRecoverableStateError,
  JsfResponseError,
  JsfStateManager,
  JsfViewRecoveryExhaustedError,
  parseJsfForm,
  parseJsfPartialResponse,
  withViewRecovery,
  type JsfControlPair,
  type PageResponse,
} from "../../src/core/jsf/index.js";

const FIXTURE_DIRECTORY = fileURLToPath(new URL("../fixtures/pj/", import.meta.url));
const RESULT_URL = "https://jurisprudencia.pj.gob.pe/jurisprudenciaweb/faces/page/resultado.xhtml";
const FORM_SELECTOR = "form#formBuscador";

async function fixture(name: string): Promise<string> {
  return readFile(`${FIXTURE_DIRECTORY}${name}`, "utf8");
}

function response(body: string, overrides: Partial<PageResponse> = {}): PageResponse {
  return {
    effectiveUrl: RESULT_URL,
    contentType: "text/html;charset=UTF-8",
    body,
    status: 200,
    ...overrides,
  };
}

function semanticBody(value: string): readonly (readonly [string, string])[] {
  return [...new URLSearchParams(value.trim()).entries()];
}

const PAGE_2_AJAX: readonly JsfControlPair[] = [
  ["javax.faces.source", "formBuscador:data1"],
  ["javax.faces.partial.event", "click"],
  ["javax.faces.partial.execute", "formBuscador:data1 @component"],
  ["javax.faces.partial.render", "@component"],
  ["formBuscador:data1:page", "2"],
  ["org.richfaces.ajax.component", "formBuscador:data1"],
  ["formBuscador:data1", "formBuscador:data1"],
  ["AJAX:EVENTS_COUNT", "1"],
  ["javax.faces.partial.ajax", "true"],
];

const DETAIL_AJAX: readonly JsfControlPair[] = [
  ["javax.faces.source", "formBuscador:repeat:10:j_idt491"],
  ["javax.faces.partial.event", "click"],
  ["javax.faces.partial.execute", "formBuscador:repeat:10:j_idt491 @component"],
  ["javax.faces.partial.render", "@component"],
  ["uuid", "00000000-0000-4000-8000-000000000011"],
  ["recurso", "Apelación"],
  ["nroexp", "PJ-FIX-0011"],
  ["palabras", "paginación"],
  ["pretensiones", "Materia ficticia B"],
  ["normaDI", ""],
  ["tipoResolucion", "Ejecutoria Suprema"],
  ["fechaResolucion", "30/01/2024"],
  ["sala", "Sala Ficticia C"],
  ["sumilla", "Segunda página anonimizada"],
  ["formBuscador:repeat:10:j_idt491", "formBuscador:repeat:10:j_idt491"],
  ["org.richfaces.ajax.component", "formBuscador:repeat:10:j_idt491"],
  ["AJAX:EVENTS_COUNT", "1"],
  ["javax.faces.partial.ajax", "true"],
];

describe("snapshot de formularios JSF", () => {
  it("resuelve action y conserva controles exitosos, duplicados, Unicode y orden DOM", () => {
    const html = `
      <form id="target" action="../submit" method="post">
        <input type="hidden" name="javax.faces.ViewState" value="STATE" />
        <input type="hidden" name="token:extra" value="uno" />
        <input type="hidden" name="token:extra" value="dos" />
        <input name="texto" value="ámbito jurídico" />
        <input type="checkbox" name="activo" checked />
        <input type="checkbox" name="omitido" />
        <input type="image" name="accion" value="accion" />
        <select name="varios" multiple>
          <option value="α" selected>Alfa</option><option value="β" selected>Beta</option>
        </select>
        <textarea name="nota">línea ñ</textarea>
        <fieldset disabled><input name="deshabilitado" value="secreto" /></fieldset>
      </form>`;
    const snapshot = parseJsfForm(html, "https://example.test/a/page.xhtml", "#target");

    expect(snapshot).toMatchObject({
      action: "https://example.test/submit",
      method: "POST",
      formId: "target",
      viewStateName: "javax.faces.ViewState",
      viewStateValue: "STATE",
    });
    expect(snapshot.successfulControls).toEqual([
      ["javax.faces.ViewState", "STATE"],
      ["token:extra", "uno"],
      ["token:extra", "dos"],
      ["texto", "ámbito jurídico"],
      ["activo", "on"],
      ["varios", "α"],
      ["varios", "β"],
      ["nota", "línea ñ"],
    ]);
  });

  it("rechaza formularios múltiples si la selección no es inequívoca", () => {
    const html = "<form id='a'></form><form id='b'></form>";
    expect(() => parseJsfForm(html, RESULT_URL)).toThrowError(JsfFormParseError);
    expect(() => parseJsfForm(html, RESULT_URL, "form")).toThrowError(/no es inequívoco/);
    expect(parseJsfForm(html, RESULT_URL, "#b").formId).toBe("b");
  });
});

describe("construcción de postbacks", () => {
  it("coincide semánticamente con el payload capturado de búsqueda", async () => {
    const snapshot = parseJsfForm(await fixture("initial.html"), RESULT_URL, FORM_SELECTOR);
    const built = buildJsfPostback(snapshot, {
      set: [["formBuscador:txtBusqueda", "derecho"]],
      append: [
        ["formBuscador:j_idt31", "formBuscador:j_idt31"],
        ["forward", "buscar"],
        ["busqueda", "especializada"],
        ["formBuscador:j_idt34", "21"],
        ["formBuscador:j_idt35", "DESC"],
        ["formBuscador:j_idt36", "Principal"],
        ["formBuscador:j_idt37", "1"],
      ],
    });

    expect(semanticBody(built.body)).toEqual(
      semanticBody(await fixture("requests/search-page-1.urlencoded")),
    );
  });

  it("preserva nombres con dos puntos, duplicados y codificación Unicode", () => {
    const snapshot = parseJsfForm(
      "<form method='post'><input name='x:y' value='á'><input name='x:y' value='β'></form>",
      RESULT_URL,
      "form",
    );
    expect(buildJsfPostback(snapshot).body).toBe("x%3Ay=%C3%A1&x%3Ay=%CE%B2");
    expect(() => buildJsfPostback(snapshot, { set: [["inventado", "x"]] })).toThrowError(
      JsfPostbackBuildError,
    );
  });

  it("coincide con página 2 y usa el ViewState de la página anterior", async () => {
    const snapshot = parseJsfForm(await fixture("search-page-1.html"), RESULT_URL, FORM_SELECTOR);
    const built = buildJsfPostback(snapshot, { append: PAGE_2_AJAX });
    expect(semanticBody(built.body)).toEqual(
      semanticBody(await fixture("requests/page-2.urlencoded")),
    );
    expect(new URLSearchParams(built.body).get("javax.faces.ViewState")).toBe(
      "FIXTURE_VIEWSTATE_1",
    );
  });
});

describe("partial-response RichFaces", () => {
  it("extrae todos los updates, ViewState y fragmentos CDATA", async () => {
    const partial = parseJsfPartialResponse(await fixture("partial-page-2.xml"));
    expect(partial.updates.size).toBe(9);
    expect(partial.updates.get("formBuscador:panel")).toContain("PJ-FIX-0011");
    expect(partial.updates.get("javax.faces.ViewState")).toBe("FIXTURE_VIEWSTATE_2");
  });

  it("extrae redirect y error de fixtures sintéticos contractuales", async () => {
    const redirectFixture = await fixture("partial-redirect.xml");
    const errorFixture = await fixture("partial-error.xml");
    expect(redirectFixture).toContain("synthetic-contractual");
    expect(errorFixture).toContain("synthetic-contractual");
    expect(parseJsfPartialResponse(redirectFixture).redirectUrl).toBe(
      "/jurisprudenciaweb/faces/page/inicio.xhtml",
    );
    expect(parseJsfPartialResponse(errorFixture).error).toEqual({
      name: "javax.faces.application.ViewExpiredException",
      message: "Vista expirada sintética para prueba offline.",
    });
  });

  it("rechaza XML inválido con snapshot que no expone el cuerpo", () => {
    const secret = "TOKEN_REUTILIZABLE";
    try {
      parseJsfPartialResponse(`<partial-response><update>${secret}</partial-response>`);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(JsfPartialResponseParseError);
      expect((error as JsfPartialResponseParseError).bodySnapshot).toMatch(/^\[REDACTED_XML/);
      expect((error as JsfPartialResponseParseError).bodySnapshot).not.toContain(secret);
    }
  });

  it("rechaza updates duplicados para evitar transiciones ambiguas", () => {
    const duplicate = `<?xml version="1.0"?><partial-response><changes>
      <update id="panel"><![CDATA[primero]]></update>
      <update id="panel"><![CDATA[segundo]]></update>
    </changes></partial-response>`;

    expect(() => parseJsfPartialResponse(duplicate)).toThrowError(JsfPartialResponseParseError);
  });
});

describe("transiciones atómicas de JsfStateManager", () => {
  it("actualiza estado con HTML completo y luego con XML parcial sin perder hidden fields", async () => {
    const manager = new JsfStateManager(FORM_SELECTOR);
    manager.accept(response(await fixture("initial.html")));
    manager.accept(response(await fixture("search-page-1.html")));
    expect(manager.current.viewStateValue).toBe("FIXTURE_VIEWSTATE_1");

    const transition = manager.accept(
      response(await fixture("partial-page-2.xml"), { contentType: "text/xml;charset=UTF-8" }),
      { requiredUpdateId: "formBuscador:panel" },
    );
    expect(transition.kind).toBe("partial");
    expect(manager.current.viewStateValue).toBe("FIXTURE_VIEWSTATE_2");
    expect(manager.current.successfulControls).toContainEqual([
      "formBuscador:buPretensionValue",
      "",
    ]);
    expect(manager.current.successfulControls).toContainEqual(["formBuscador:spinner", "2"]);

    const detail = buildJsfPostback(manager.current, { append: DETAIL_AJAX });
    expect(semanticBody(detail.body)).toEqual(
      semanticBody(await fixture("requests/detail.urlencoded")),
    );
  });

  it("no promueve estado ante XML inválido o partial sin panel requerido", async () => {
    const manager = new JsfStateManager(FORM_SELECTOR);
    manager.accept(response(await fixture("search-page-1.html")));
    const before = manager.current;

    expect(() =>
      manager.accept(response("<partial-response>", { contentType: "text/xml" })),
    ).toThrowError(JsfPartialResponseParseError);
    expect(manager.current).toBe(before);

    const incomplete = `<?xml version="1.0"?><partial-response><changes>
      <update id="javax.faces.ViewState"><![CDATA[NEW_STATE]]></update>
    </changes></partial-response>`;
    expect(() =>
      manager.accept(response(incomplete, { contentType: "text/xml" }), {
        requiredUpdateId: "panel-resultados",
      }),
    ).toThrowError(JsfRecoverableStateError);
    expect(manager.current).toBe(before);
  });

  it("clasifica 500 text/xml vacío y ViewExpiredException sin reemplazar estado", async () => {
    const manager = new JsfStateManager(FORM_SELECTOR);
    manager.accept(response(await fixture("search-page-1.html")));
    const before = manager.current;
    const expiredPartial = await fixture("partial-error.xml");
    expect(() =>
      manager.accept(response("", { status: 500, contentType: "text/xml;charset=UTF-8" })),
    ).toThrowError(JsfRecoverableStateError);
    expect(() =>
      manager.accept(response(expiredPartial, { contentType: "text/xml;charset=UTF-8" })),
    ).toThrowError(JsfRecoverableStateError);
    expect(manager.current).toBe(before);
  });

  it("no confunde una respuesta de login inesperada con resultados vacíos", () => {
    const manager = new JsfStateManager(FORM_SELECTOR);
    expect(() =>
      manager.accept(
        response("<html><body><form id='login'><input name='usuario'></form></body></html>"),
      ),
    ).toThrowError(JsfResponseError);
  });
});

describe("recuperación acotada de vista", () => {
  it("ejecuta bootstrap/reposicionamiento una vez y reintenta la operación", async () => {
    let attempts = 0;
    const operation = vi.fn(() => {
      attempts += 1;
      if (attempts === 1) {
        return Promise.reject(new JsfRecoverableStateError("VIEW_EXPIRED", "expirada"));
      }
      return Promise.resolve("ok");
    });
    const recover = vi.fn(() => Promise.resolve());
    await expect(withViewRecovery(operation, recover)).resolves.toBe("ok");
    expect(operation).toHaveBeenCalledTimes(2);
    expect(recover).toHaveBeenCalledTimes(1);
  });

  it("detiene la segunda expiración sin entrar en loop", async () => {
    const operation = vi.fn(() =>
      Promise.reject(new JsfRecoverableStateError("VIEW_EXPIRED", "expirada otra vez")),
    );
    const recover = vi.fn(() => Promise.resolve());
    await expect(withViewRecovery(operation, recover)).rejects.toBeInstanceOf(
      JsfViewRecoveryExhaustedError,
    );
    expect(operation).toHaveBeenCalledTimes(2);
    expect(recover).toHaveBeenCalledTimes(1);
  });
});
