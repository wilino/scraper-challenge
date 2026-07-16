export const PJ_FORM_ID = "formBuscador";
export const PJ_VIEW_STATE = "javax.faces.ViewState";

export const PJ_SELECTORS = {
  form: `form#${PJ_FORM_ID}`,
  viewState: `input[name="${PJ_VIEW_STATE}"]`,
  resultSummary: `#${PJ_FORM_ID}\\:optResultado`,
  resultPanel: `#${PJ_FORM_ID}\\:panel`,
  resultRecords: `#${PJ_FORM_ID}\\:panel > [id^="${PJ_FORM_ID}:repeat:"]`,
  listField: "[data-field]",
  detailLink: 'a[title="Ver"]',
  dataScroller: `#${PJ_FORM_ID}\\:data1`,
  nextPage: `#${PJ_FORM_ID}\\:data1_ds_next`,
  lastPage: `#${PJ_FORM_ID}\\:data1_ds_l`,
  supremePopup: `#${PJ_FORM_ID}\\:popupResolucion`,
  superiorPopup: `#${PJ_FORM_ID}\\:popupResolucionSuperior`,
  detailLabels: "section dl > dt",
} as const;

export const PJ_COMPONENTS = {
  dataScroller: `${PJ_FORM_ID}:data1`,
  pageParameter: `${PJ_FORM_ID}:data1:page`,
  supremePopup: `${PJ_FORM_ID}:popupResolucion`,
  superiorPopup: `${PJ_FORM_ID}:popupResolucionSuperior`,
} as const;

export type PjCourt = "supreme" | "superior";

export const DETAIL_POPUP_BY_COURT = {
  supreme: PJ_COMPONENTS.supremePopup,
  superior: PJ_COMPONENTS.superiorPopup,
} as const satisfies Record<PjCourt, string>;

/**
 * The keys are deliberately semantic while the values retain the labels emitted
 * by PJ. Spelling variants observed in Superior are aliases of the same field.
 */
export const DETAIL_LABEL_ALIASES: Readonly<Record<string, string>> = {
  "Fecha de la Resolución": "resolutionDate",
  "Tipo de Resolución": "resolutionType",
  "Fallo/Sentido de la Resolución": "decision",
  "Jueces Supremos": "judges",
  Jueces: "judges",
  Ponente: "reportingJudge",
  Dirimente: "castingJudge",
  Discordia: "dissent",
  "Voto Concordado": "concurringVote",
  "Fundamentos Adicionales": "additionalGrounds",
  Sumilla: "summary",
  "Norma de Derecho Interno": "domesticLaw",
  "Jurisprudencia Nacional/Acuerdo Plenario": "nationalPrecedent",
  "Norma de Derecho Internacional": "internationalLaw",
  "Organismo Emisor de Jursiprudencia Internacional": "internationalIssuer",
  "Palabras Clave": "keywords",
  Relevante: "relevant",
  Vinculante: "binding",
  "Fecha de Publicación en El Peruano": "officialPublicationDate",
  Especialidad: "specialty",
  Sala: "chamber",
  Instancia: "chamber",
  "Distrito Judicial de Procedencia": "district",
  Distrito: "district",
  "Materia de la Causa": "subjectMatter",
  "Pretensión/Delito": "claimOrOffense",
  "Pretención/Delito": "claimOrOffense",
  "Régimen Procesal": "proceduralRegime",
  "Tipo de Proceso": "processType",
  Proceso: "processType",
  "N° de Expediente de la Sala Superior": "superiorCaseNumber",
  "Archivo de la Resolución": "resolutionFile",
  "Fecha de Demanda": "filingDate",
  "Fecha de Calificación": "admissionDate",
  "Organo Jurisdiccional de procedencia": "originatingCourt",
  Fallo: "lowerDecision",
  "Expediente de Procedencia": "lowerCaseNumber",
  "Fecha de Resolución de Procedencia": "lowerResolutionDate",
  "Organo Jurisdiccional de Origen": "originalCourt",
  "Fallo de Origen": "originalDecision",
  "Tipo de Resolución de Origen": "originalResolutionType",
  "Expediente de Origen": "originalCaseNumber",
  "Fecha de Resolución de Origen": "originalResolutionDate",
  "Fecha de Denuncia de Origen": "originalComplaintDate",
};
