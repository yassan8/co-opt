/**
 * JS_lensDraw v3 - Main Application Entry Point (Refactored)
 * 
 * This file serves as the main entry point of the application. 
 * It initializes the application using modular components and sets up the main functionality.
 */



// =============================================================================
// IMPORTS
// =============================================================================

// Core modules
import { APP_CONFIG, initializeReferences, setIsGeneratingSpotDiagram, setIsGeneratingTransverseAberration, getCamera, getControls } from './core/app-config.ts';
import { initializeThreeJS, initializeLighting, renderScene, animate } from './core/scene-setup.ts';

// Table data modules
import { loadTableData as loadSourceTableData, saveTableData as saveSourceTableData, tableSource, mountTableSourceIfReady } from './data/table-source.ts';
import { loadTableData as loadObjectTableData, saveTableData as saveObjectTableData, tableObject, mountTableObjectIfReady } from './data/table-object.ts';
import { loadTableData as loadOpticalSystemTableData, saveTableData as saveLensTableData, tableOpticalSystem, updateAllRefractiveIndices, updateOpticalPropertiesFromMaterial, mountTableOpticalSystemIfReady } from './data/table-optical-system.ts';

// Optical system modules
import { drawOpticalSystemSurfaces, clearAllOpticalElements, findStopSurface } from './optical/system-renderer.ts';
import { drawAsphericProfile, drawPlaneProfile, drawLensSurface, drawLensSurfaceWithOrigin, drawLensCrossSection, drawLensCrossSectionWithSurfaceOrigins, drawSemidiaRingWithOriginAndSurface, asphericSurfaceZ, addMirrorBackText } from './optical/surface.ts';

// Ray tracing modules
import { traceRay, calculateSurfaceOrigins, transformPointToLocal, calculateAllSurfacesLocalCoordinates, resetToSurfaceCoordinates, shiftToChiefRayOrigin, restoreFromLocalCoordinates, transformToChiefRayLocalCoordinates, calculateChiefRaySurfaceIntersections } from './raytracing/core/ray-tracing.ts';
import { calculateFocalLength, calculateBackFocalLength, calculateImageDistance, calculateEntrancePupilDiameter, calculateExitPupilDiameter, calculateFullSystemParaxialTrace, calculateParaxialData, debugParaxialRayTrace, calculatePupilsByNewSpec, findStopSurfaceIndex } from './raytracing/core/ray-paraxial.ts';

// Marginal ray modules
import { calculateAdaptiveMarginalRay, calculateAllMarginalRays } from './raytracing/core/ray-marginal.ts';

// Analysis modules
import { generateSpotDiagram, drawSpotDiagram, generateSurfaceOptions } from './evaluation/spot-diagram.ts';
import { calculateTransverseAberration, getFieldAnglesFromSource, getPrimaryWavelengthForAberration, validateAberrationData, calculateChiefRayNewton, getEstimatedEntrancePupilDiameter } from './evaluation/aberrations/transverse-aberration.ts';
import { plotTransverseAberrationDiagram, showTransverseAberrationInNewWindow } from './evaluation/aberrations/transverse-aberration-plot.ts';
import { showWavefrontDiagram } from './evaluation/wavefront/wavefront-plot.ts';
import { OpticalPathDifferenceCalculator, WavefrontAberrationAnalyzer, createOPDCalculator, createWavefrontAnalyzer } from './evaluation/wavefront/wavefront.ts';
import { PSFCalculator } from './evaluation/psf/psf-calculator.ts';
import { PSFPlotter, PSFDisplayManager } from './evaluation/psf/psf-plot.ts';
import { showMTFDiagram } from './evaluation/mtf-plot.ts';
import { fitZernikeWeighted, reconstructOPD, getZernikeName } from './evaluation/wavefront/zernike-fitting.ts';
import { calculateOPDWithZernike, displayZernikeAnalysis, exportZernikeAnalysisJSON } from './evaluation/wavefront/opd-zernike-analysis.ts';
import { generateCrossBeam, generateFiniteSystemCrossBeam, RayColorSystem } from './raytracing/generation/gen-ray-cross-finite.ts';
import { generateInfiniteSystemCrossBeam, RayColorSystem as InfiniteRayColorSystem } from './raytracing/generation/gen-ray-cross-infinite.ts';
// Distortion analysis
import { calculateDistortionData } from './evaluation/aberrations/distortion.ts';
import { plotDistortionPercent, generateDistortionPlots, plotGridDistortion, generateGridDistortionPlot } from './evaluation/aberrations/distortion-plot.ts';

// Utility modules
import { getGlassDataWithSellmeier, calculateRefractiveIndex, getPrimaryWavelength } from './data/glass.ts';
import { multiplyMatrices, createRotationMatrixX, createRotationMatrixY, createRotationMatrixZ, createRotationMatrix, calculateLocalCoordinateTransforms, applyMatrixToVector, calculateOpticalSystemOffset } from './utils/math.ts';
import { getOpticalSystemRows, getObjectRows, getSourceRows, outputParaxialDataToDebug, outputSeidelCoefficientsToDebug, outputDebugSystemData, displayCoordinateTransformMatrix, debugTableStatus, initializeTablesWithDummyData, renderBlockContributionSummaryFromSeidel, renderSystemConstraintsFromSurfaceRows } from './utils/data-utils.ts';
import { initAIAssistant } from './ai/ai-assistant.ts';

// Ray rendering modules
import { setRayEmissionPattern, setRayColorMode, getRayEmissionPattern, getRayColorMode, optimizeObjectPositionForStop, optimizeAngleObjectPosition, generateRayStartPointsForObject, drawRayWithSegmentColors } from './optical/ray-renderer.ts';

// UI modules
import { setupRayPatternButtons, setupRayColorButtons, setupViewButtons, setupOpticalSystemChangeListeners, setupSimpleViewButtons, setupTransformationControls, updateTransformSurfaceSelect, setupAnalysisWindows } from './ui/event-handlers.ts';
import { updateSurfaceNumberSelect, updateAllUIElements, initializeUIEventListeners } from './ui/ui-updates.ts';
import { loadFromCompressedDataHashIfPresent, setupDOMEventHandlers, loadSystemConfigurations, saveSystemConfigurations, loadActiveConfigurationToTables, refreshBlockInspector } from './ui/dom-event-handlers.ts';
import { updateWavefrontObjectSelect, initializeWavefrontObjectUI, debugResetObjectTable } from './ui/wavefront-object-select.ts';
import { initializeConfigurationUI } from './ui/configuration-handlers.ts';
import { getActiveConfiguration } from './data/table-configuration.ts';
import { expandBlocksToOpticalSystemRows } from './data/block-schema.ts';

// Editor modules (must be imported to initialize)
import './ui/editors/system-requirements-editor.ts';
import './ui/editors/merit-function-editor.ts';



// Suggest (Design Intent) implementation (adds window.SuggestDesignIntent)
import './optimization/suggest-design-intent.js';

// Debug modules
import { debugSceneContents, debugDrawingIssues, adjustCameraView, showSceneBoundingBox } from './debug/debug-utils.ts';

// Analysis modules
import { clearAllDrawing, showSpotDiagram, showTransverseAberrationDiagram, showLongitudinalAberrationDiagram, showAstigmatismDiagram, showIntegratedAberrationDiagram, outputChiefRayConvergenceData, calculateSceneBounds, fitCameraToScene } from './analysis/optical-analysis.ts';

