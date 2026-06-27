/**
 * Mathematical utilities for 3D matrix operations and coordinate transformations
 */

// import { calculateSurfaceOrigins } from '../ray-tracing.ts'; // 循環インポートを回避

/**
 * Matrix multiplication for 3x3 matrices
 * @param {number[][]} a - First matrix
 * @param {number[][]} b - Second matrix
 * @returns {number[][]} Result matrix
 */
export function multiplyMatrices(a, b) {
    const result = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (let i = 0; i < 3; i++) {
        for (let j = 0; j < 3; j++) {
            result[i][j] = a[i][0] * b[0][j] + a[i][1] * b[1][j] + a[i][2] * b[2][j];
        }
    }
    return result;
}

/**
 * Create rotation matrix for X-axis
 * @param {number} angle - Rotation angle in radians
 * @returns {number[][]} Rotation matrix
 */
export function createRotationMatrixX(angle) {
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    return [
        [1, 0, 0],
        [0, cos, -sin],
        [0, sin, cos]
    ];
}

/**
 * Create rotation matrix for Y-axis
 * @param {number} angle - Rotation angle in radians
 * @returns {number[][]} Rotation matrix
 */
export function createRotationMatrixY(angle) {
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    return [
        [cos, 0, sin],
        [0, 1, 0],
        [-sin, 0, cos]
    ];
}

/**
 * Create rotation matrix for Z-axis
 * @param {number} angle - Rotation angle in radians
 * @returns {number[][]} Rotation matrix
 */
export function createRotationMatrixZ(angle) {
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    return [
        [cos, -sin, 0],
        [sin, cos, 0],
        [0, 0, 1]
    ];
}

/**
 * Create rotation matrix based on order
 * @param {number} tiltX - Tilt around X-axis
 * @param {number} tiltY - Tilt around Y-axis
 * @param {number} tiltZ - Tilt around Z-axis
 * @param {number} order - Rotation order (0 or 1)
 * @returns {number[][]} Combined rotation matrix
 */
export function createRotationMatrix(tiltX, tiltY, tiltZ, order) {
    const rotX = createRotationMatrixX(tiltX);
    const rotY = createRotationMatrixY(tiltY);
    const rotZ = createRotationMatrixZ(tiltZ);
    
    if (order === 0) {
        // Order 0: R = Rx.Ry.Rz
        return multiplyMatrices(rotX, multiplyMatrices(rotY, rotZ));
    } else {
        // Order 1: R = Rz.Ry.Rx
        return multiplyMatrices(rotZ, multiplyMatrices(rotY, rotX));
    }
}

/**
 * Calculate local coordinate transformations only (no global accumulation)
 * @param {Array} coordinateTransforms - Array of coordinate transform data
 * @param {Array} surfaces - Array of surface data
 * @returns {Array} Array of local coordinate transformations
 */
export function calculateLocalCoordinateTransforms(coordinateTransforms, surfaces) {
    const localTransforms = [];
    
    // Process each coordinate transform
    for (let i = 0; i < coordinateTransforms.length; i++) {
        const transform = coordinateTransforms[i];
        
        // Create individual rotation matrix for this transform only
        const rotationMatrix = createRotationMatrix(
            transform.tiltX, 
            transform.tiltY, 
            transform.tiltZ, 
            transform.order
        );
        
        // Determine local coordinates L (no global accumulation)
        let localCoords = [0, 0, 0];
        
        if (transform.operationType === 'CB') {
            // CB face: L = {Decenter X, Decenter Y, 0} - NO thickness in rotation
            localCoords = [
                transform.decenterX || 0,
                transform.decenterY || 0,
                0
            ];
        } else {
            // Normal surface: L = {0, 0, 0} - NO thickness in rotation
            localCoords = [0, 0, 0];
        }
        
        // Calculate local coordinates only: Local = Rn.L (no offset accumulation)
        const localTransformed = applyMatrixToVector(rotationMatrix, localCoords);
        
        localTransforms.push({
            index: i,
            localCoords: localTransformed,
            rotationMatrix: rotationMatrix,
            originalTransform: transform
        });
        
        // DO NOT add thickness to rotation - thickness is handled separately according to 座標変換説明.md
    }
    
    return localTransforms;
}

/**
 * Apply matrix transformation to vector
 * @param {number[][]} matrix - 3x3 transformation matrix
 * @param {number[]} vector - 3D vector [x, y, z]
 * @returns {number[]} Transformed vector
 */
export function applyMatrixToVector(matrix, vector) {
    return [
        matrix[0][0] * vector[0] + matrix[0][1] * vector[1] + matrix[0][2] * vector[2],
        matrix[1][0] * vector[0] + matrix[1][1] * vector[1] + matrix[1][2] * vector[2],
        matrix[2][0] * vector[0] + matrix[2][1] * vector[1] + matrix[2][2] * vector[2]
    ];
}

/**
 * Calculate optical system center offset based on object and image positions
 * @param {Array} opticalSystemData - Optical system data
 * @returns {Object} Offset data with object and image positions
 */
export function calculateOpticalSystemOffset(opticalSystemData) {
    if (!opticalSystemData || opticalSystemData.length === 0) {
        return {
            z_object: 0,
            y_object: 0,
            offset_z: 0,
            offset_y: 0
        };
    }
    
    try {
        // Calculate surface origins to get actual Z positions
        const surfaceOrigins = calculateSurfaceOrigins(opticalSystemData);
        
        if (!surfaceOrigins || surfaceOrigins.length === 0) {
            return {
                z_object: 0,
                y_object: 0,
                offset_z: 0,
                offset_y: 0
            };
        }
        
        // Find object surface (first surface) and image surface (last surface)
        const objectOrigin = surfaceOrigins[0] ? surfaceOrigins[0].origin : { x: 0, y: 0, z: 0 };
        const imageOrigin = surfaceOrigins[surfaceOrigins.length - 1] ? 
                           surfaceOrigins[surfaceOrigins.length - 1].origin : { x: 0, y: 0, z: 0 };
        
        // Calculate center offset
        const centerZ = (objectOrigin.z + imageOrigin.z) / 2;
        const centerY = (objectOrigin.y + imageOrigin.y) / 2;
        
        return {
            z_object: objectOrigin.z,
            y_object: objectOrigin.y,
            offset_z: centerZ - objectOrigin.z,
            offset_y: centerY - objectOrigin.y
        };
    } catch (error) {
        console.error('Error in calculateOpticalSystemOffset:', error);
        return {
            z_object: 0,
            y_object: 0,
            offset_z: 0,
            offset_y: 0
        };
    }
}
